// Local task topology. The runner publishes a complete wave after all agents in the prior wave settle.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  linkSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const validFallbackAfter = (value) => Number.isSafeInteger(value) && value >= 2;

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const validId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value);
const distinctIds = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every(validId) &&
  new Set(values).size === values.length;
const waveFile = (dir, n) => join(dir, 'wave-' + n + '.json');

function validate(spec) {
  if (
    !validId(spec.run) ||
    !Number.isSafeInteger(spec.wave) ||
    spec.wave < 1 ||
    !distinctIds(spec.team) ||
    !isAbsolute(spec.root) ||
    realpathSync(spec.root) !== spec.root ||
    !Array.isArray(spec.checks)
  )
    throw Error('Invalid wave header');
  if (!validFallbackAfter(spec.fallbackAfter))
    throw Error('fallbackAfter must be an integer of at least two waves');
  if (spec.coordination !== undefined && spec.coordination !== 'scoped-v1')
    throw Error('Unknown wave coordination mode');
  const places = new Set(),
    ids = new Set();
  for (const c of spec.checks) {
    if (
      !validId(c.id) ||
      ids.has(c.id) ||
      typeof c.place !== 'string' ||
      !c.place ||
      isAbsolute(c.place) ||
      resolve(spec.root, c.place) !== spec.root + sep + c.place ||
      places.has(c.place) ||
      !distinctIds(c.owners) ||
      !c.owners.every((a) => spec.team.includes(a)) ||
      !validId(c.revision)
    )
      throw Error('Invalid or ambiguous check');
    if (spec.coordination === 'scoped-v1') {
      if (!['own', 'directed', 'dispute'].includes(c.class)) throw Error('Missing or invalid conflict class');
      if ((c.class === 'dispute') !== (c.owners.length > 1)) throw Error('Conflict class contradicts owners');
    }
    places.add(c.place);
    ids.add(c.id);
  }
}

// A run has its own local wave directory. Exclusive links prevent two publishers replacing the same wave.
export function publishWave(dir, spec) {
  validate(spec);
  mkdirSync(dir, { recursive: true });
  const prev = spec.wave > 1 ? read(waveFile(dir, spec.wave - 1)) : null;
  if (
    prev &&
    (prev.run !== spec.run ||
      prev.coordination !== spec.coordination ||
      prev.root !== spec.root ||
      prev.fallbackAfter !== spec.fallbackAfter ||
      digest([...prev.team].sort()) !== digest([...spec.team].sort()))
  )
    throw Error('Use a new wave directory for a new task or team');
  const checks = spec.checks.map((check) => {
    const c = {
      id: check.id,
      place: check.place,
      owners: [...check.owners].sort(),
      revision: check.revision,
    };
    const identity = [c.id, c.place, c.owners, c.revision];
    if (spec.coordination === 'scoped-v1') {
      c.class = check.class;
      identity.push(c.class);
    }
    const generation = digest(identity);
    const old = prev?.checks.find((p) => p.generation === generation);
    const sinceWave = old?.sinceWave ?? spec.wave;
    const loneWaves =
      spec.checks.length === 1 ? (prev?.checks.length === 1 && old ? old.loneWaves : 0) + 1 : 0;
    return { ...c, generation, sinceWave, loneWaves };
  });
  const wave = {
    run: spec.run,
    wave: spec.wave,
    root: spec.root,
    team: [...spec.team],
    fallbackAfter: spec.fallbackAfter,
    checks,
    ...(spec.coordination ? { coordination: spec.coordination } : {}),
  };
  const temp = join(dir, '.wave-' + randomUUID());
  writeFileSync(temp, JSON.stringify(wave), { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, waveFile(dir, spec.wave));
  } finally {
    unlinkSync(temp);
  }
  return wave;
}

export function currentWave(dir) {
  // Open immutable files in sequence. No mutable pointer can regress under publication retries.
  let n = 1;
  while (existsSync(waveFile(dir, n + 1))) n++;
  return read(waveFile(dir, n));
}

function ranked(candidates, wave, check) {
  return [...candidates].sort((a, b) => {
    const x = digest([wave.run, wave.wave, check.id, a]),
      y = digest([wave.run, wave.wave, check.id, b]);
    return x < y ? 1 : x > y ? -1 : a.localeCompare(b);
  })[0];
}
export function assignment(wave, check, config) {
  const threshold = validFallbackAfter(config.fallbackAfter) ? config.fallbackAfter : wave.fallbackAfter;
  const outsiders = wave.team.filter((a) => !check.owners.includes(a));
  if (
    config.tieBreak === 'hash' &&
    config.waitForTrace === true &&
    (wave.coordination !== 'scoped-v1' || check.class !== 'own') &&
    check.loneWaves >= threshold &&
    outsiders.length
  )
    return {
      agent: ranked(outsiders, { ...wave, wave: wave.wave - check.loneWaves + threshold }, check),
      fallback: true,
    };
  if (check.owners.length === 1) return { agent: check.owners[0], fallback: false };
  if (check.owners.length > 1 && config.tieBreak !== 'hash') return { agent: null, fallback: false };
  return { agent: ranked(check.owners, wave, check), fallback: false };
}

export function traceRequired(wave, check, config) {
  return config.waitForTrace === true && (wave.coordination !== 'scoped-v1' || check.class === 'directed');
}

export function checkAt(wave, cwd, path) {
  if (typeof path !== 'string' || !path || path.startsWith('~') || path.startsWith('@')) return undefined;
  const target = resolve(cwd, path);
  return wave.checks.find((c) => join(wave.root, c.place) === target);
}
export function validDestination(wave, check) {
  const file = join(wave.root, check.place);
  if (realpathSync(dirname(file)) !== dirname(file)) return false;
  if (!existsSync(file)) {
    // lstat is needed to distinguish a new file from a dangling symlink.
    return !lstatSync(file, { throwIfNoEntry: false });
  }
  const stat = statSync(file);
  return realpathSync(file) === file && stat.isFile() && stat.nlink === 1;
}
export function matchesTrace(m, wave, check, to) {
  return (
    m.kind === 'requirement' &&
    m.run === wave.run &&
    m.generation === check.generation &&
    m.wave >= check.sinceWave &&
    m.wave <= wave.wave &&
    m.to === to &&
    m.by !== to &&
    wave.team.includes(m.by)
  );
}
