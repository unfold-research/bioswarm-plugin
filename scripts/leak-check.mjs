#!/usr/bin/env node
// leak-check: blocks secrets, personal data and private references before they reach a public repository.
// No dependencies. Runs as a pre-commit hook (.githooks/pre-commit) and in CI (.github/workflows/leak-check.yml).
//
//   node scripts/leak-check.mjs              scan every tracked file
//   node scripts/leak-check.mjs --staged     scan the staged version of staged files (pre-commit)
//   node scripts/leak-check.mjs --authors A..B   check author and committer e-mails of a commit range
//   node scripts/leak-check.mjs --hash word  print the hash line for a private term (maintainers only)
//
// Private terms (people, hosts, companies) are kept as salted SHA-256 hashes in .leakcheck/terms, so the list
// itself does not leak them. A reviewed false positive goes into .leakcheck/allow as `path<TAB>sha256(line)`;
// the checker prints the exact line to add.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SALT = 'unfold-leakcheck-v1:';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 30 });
const args = process.argv.slice(2);

if (args[0] === '--hash') { for (const w of args.slice(1)) console.log(sha(SALT + w.toLowerCase())); process.exit(0); }

const readLines = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
const TERMS = new Set(readLines('.leakcheck/terms'));
// Extra plain-text terms a maintainer keeps outside the repository.
for (const t of readLines(join(homedir(), '.config', 'unfold', 'leak-terms'))) TERMS.add(sha(SALT + t.toLowerCase()));
const ALLOW = new Set(readLines('.leakcheck/allow'));

const AUTHOR_OK = /(@users\.noreply\.github\.com|^noreply@github\.com)$/i;

if (args[0] === '--authors') {
  const range = args[1];
  const bad = git('log', '--format=%H%x09%ae%x09%ce', range).trim().split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([, a, c]) => !AUTHOR_OK.test(a) || !AUTHOR_OK.test(c));
  for (const [h, a, c] of bad) console.error(`commit ${h.slice(0, 7)}: author <${a}> committer <${c}> is not a GitHub noreply address`);
  if (bad.length) { console.error('\nUse your GitHub noreply e-mail for commits here (git config user.email <id>+<login>@users.noreply.github.com).'); process.exit(1); }
  console.log(`leak-check: ${range} authors ok`); process.exit(0);
}

const TEXT = /\.(md|mdx|txt|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|mjs|cjs|js|ts|tsx|jsx|py|rb|go|rs|swift|java|kt|tex|bib|cff|html?|css|svg|xml|sql|slice|service|timer|dockerfile)$|(^|\/)(Dockerfile|Makefile|\.[a-z]+rc|\.gitignore|\.gitmodules|LICENSE|README|RAW-SHA256SUMS)$/i;
const PROSE = /\.(md|mdx|txt|csv|tsv|json|jsonl|ya?ml|tex|cff|html?)$/i;
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.leakcheck\/(terms|allow))$/;

const RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token', /\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20})\b/],
  ['bearer credential', /Bearer\s+(?!<|\$|\{|\[|[A-Z_]+\b)[A-Za-z0-9._~+\/-]{24,}/],
  ['e-mail', /[A-Za-z0-9._%+-]+@(?!(?:users\.noreply\.github\.com|example\.(?:com|org|net)|unfold\.host)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|ai|dev|app|br|host|co|me|info|edu|gov)\b/i],
  ['home path', /(?:\/Users|\/home)\/(?!(?:op|svc|runner|node|user|x|me|ubuntu|alice|bob|example|\.\.\.)\b)[A-Za-z][\w.-]*/],
  ['agent id', /\bagent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/],
];
const MONEY = /US\$\s?\d|(?<![\w$\\])\$\s?\d[\d,]*\.\d/;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const publicIp = (a, b, c, d) => {
  const o = [a, b, c, d].map(Number); if (o.some((x) => x > 255)) return false;
  const [p, q, r] = o;
  if (p === 10 || p === 127 || p === 0 || p >= 224 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)) return false;
  if ((p === 192 && q === 0 && r === 2) || (p === 198 && q === 51 && r === 100) || (p === 203 && q === 0 && r === 113) || (p === 198 && (q === 18 || q === 19)) || (p === 100 && q >= 64 && q <= 127)) return false;
  if (o.join('.') === '1.2.3.4' || o.join('.') === '8.8.8.8' || o.join('.') === '1.1.1.1') return false;
  return true;
};

function scan(path, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const hits = [];
    for (const [name, re] of RULES) if (re.test(line)) hits.push(name);
    if (PROSE.test(path) && MONEY.test(line)) hits.push('dollar amount');
    for (const m of line.matchAll(IPV4)) if (publicIp(m[1], m[2], m[3], m[4])) { hits.push('public IP'); break; }
    if (TERMS.size) for (const w of line.toLowerCase().match(/[a-z0-9]+/g) || []) if (w.length > 2 && TERMS.has(sha(SALT + w))) { hits.push('private term'); break; }
    if (!hits.length) return;
    const key = `${path}\t${sha(line.trim())}`;
    if (!ALLOW.has(key)) out.push({ path, line: i + 1, hits, key });
  });
  return out;
}

const staged = args[0] === '--staged';
const files = staged
  ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)
  : git('ls-files', '-z').split('\0').filter(Boolean);
let findings = [];
for (const f of files) {
  if (SKIP.test(f) || !TEXT.test(f)) continue;
  let text;
  try { text = staged ? git('show', `:${f}`) : readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  findings = findings.concat(scan(f, text));
}
// The local committer identity must not be a personal address either (pre-commit only).
if (staged) {
  let email = '';
  try { email = git('var', 'GIT_AUTHOR_IDENT').replace(/^.*<([^>]*)>.*$/s, '$1').trim(); } catch {}
  if (email && !AUTHOR_OK.test(email)) { console.error(`leak-check: author e-mail <${email}> is not a GitHub noreply address.`); process.exitCode = 1; }
}
if (findings.length) {
  for (const f of findings) console.error(`${f.path}:${f.line}: ${f.hits.join(', ')}`);
  console.error(`\nleak-check: ${findings.length} finding(s). Remove them, or, if a maintainer confirms a false positive,\nadd the printed line(s) below to .leakcheck/allow:\n`);
  for (const f of findings) console.error(f.key);
  process.exit(1);
}
if (!process.exitCode) console.log(`leak-check: ${files.length} file(s) clean`);
