#!/usr/bin/env node
// bioswarm-pi install | on <agent-dir> [json] | off <agent-dir> | status
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { publishWave } from '../coordination.js';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const agentsDir = process.env.OPENBOT_AGENTS || join(homedir(), 'OpenBot', 'Agents');
const [cmd, dir, settings] = process.argv.slice(2);
const fail = msg => { console.error(msg); process.exit(1); };

if (cmd === 'wave') {
  if (!dir || !settings) fail('usage: bioswarm-pi wave <wave-directory> <local-observation.json>');
  const wave=publishWave(resolve(dir),JSON.parse(readFileSync(resolve(settings),'utf8')));
  console.log(JSON.stringify({wave:wave.wave,checks:wave.checks.length}));
} else if (cmd === 'install') {
  const target = join(piDir, 'extensions', 'bioswarm');
  mkdirSync(dirname(target), { recursive: true }); rmSync(target, { force: true, recursive: false });
  symlinkSync(pkg, target); console.log(`linked ${target} -> ${pkg}`);
} else if (cmd === 'on') {
  if (!dir || !existsSync(dir)) fail(`no such agent folder: ${dir}`);
  if (settings) try { JSON.parse(settings); } catch { fail('settings must be JSON'); }
  writeFileSync(join(dir, '.bioswarm'), (settings || '{}') + '\n'); console.log(`BioSwarm on for ${dir}. Start a new chat with the agent.`);
} else if (cmd === 'off') {
  if (!dir) fail('agent folder required'); rmSync(join(dir, '.bioswarm'), { force: true }); console.log(`BioSwarm off for ${dir}`);
} else if (cmd === 'status') {
  const roots = existsSync(agentsDir) ? [agentsDir] : [];
  for (const root of roots) for (const name of readdirSync(root)) {
    const d = join(root, name); if (!existsSync(join(d, '.bioswarm'))) continue;
    const log = join(d, '.bioswarm-events.jsonl'); const n = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    console.log(`${d}  events=${n}`);
  }
} else fail('usage: bioswarm-pi install | on <agent-dir> [json] | off <agent-dir> | status | wave <wave-directory> <local-observation.json>');
