// BioSwarm policy client: the connector is open, the coordination policy is not.
//
// The connector enforces rules in the agent loop (field, message ceilings, budget, acceptance gate). Which rules are
// on, and their parameters, come from the BioSwarm Control API (protocol `bioswarm.v1`, see protocol/bioswarm.v1.md).
// Without an API key, or when the API cannot be reached, the connector runs the community policy below and the
// last cached remote policy, never blocking the agent on the network.
//
// Telemetry carries only kinds, tool names, counts and costs: never prompts, messages, file contents or paths.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validFallbackAfter } from './coordination.js';

export const PROTOCOL = 'bioswarm.v1';
export const CONNECTOR_VERSION = '0.4.0';

// Community policy: the lab's published defaults, usable with no account. Hash arbitration is on (LI27, LI30: needed in
// symmetric conflicts); trace waiting is off and stays an experimental opt-in (Phase 1b and 1b-r: slower, no saving).
// Without a published wave the connector keeps the plain community rules, so hash arbitration costs nothing there.
export const COMMUNITY_POLICY = Object.freeze({
  id: 'community-1', protocol: PROTOCOL, source: 'community', ttlSeconds: 0,
  rules: Object.freeze({ runBudgetUsd: 3, messagesPerRun: 1, messageChars: 600, messagesPerSession: null, gate: null, tieBreak: 'hash', waitForTrace: false }),
});
export const COORDINATION_KEYS = ['tieBreak', 'waitForTrace'];
export const setsCoordination = (rules) => Boolean(rules) && COORDINATION_KEYS.some((key) => Object.hasOwn(rules, key));

// Rules a remote policy may set. Anything else in a response is ignored, so a policy cannot reach outside the loop.
const REMOTE_KEYS = ['runBudgetUsd', 'messagesPerRun', 'messageChars', 'messagesPerSession', 'gate', 'waitForTrace', 'tieBreak'];

export function sanitizeRules(rules) {
  const out = {};
  for (const key of REMOTE_KEYS) if (rules && Object.hasOwn(rules, key)) out[key] = rules[key];
  if (validFallbackAfter(rules?.fallbackAfter)) out.fallbackAfter = rules.fallbackAfter;
  return out;
}

// Merge order: community < remote policy < local `.bioswarm` settings. A local budget can only lower the remote one:
// the person on the machine always keeps the brake. Coordination switches come from the community policy only when
// no remote policy is in force: a Control strategy that leaves them out (for example `stigmergy`) keeps them off.
export function mergeConfig(remoteRules = COMMUNITY_POLICY.rules, localSettings = {}) {
  const community = (remoteRules ?? COMMUNITY_POLICY.rules) === COMMUNITY_POLICY.rules;
  const remote = sanitizeRules(remoteRules ?? COMMUNITY_POLICY.rules);
  const base = { ...COMMUNITY_POLICY.rules };
  if (!community) for (const key of COORDINATION_KEYS) delete base[key];
  const merged = { ...base, ...remote, ...localSettings };
  if (typeof remote.runBudgetUsd === 'number' && typeof localSettings.runBudgetUsd === 'number') merged.runBudgetUsd = Math.min(remote.runBudgetUsd, localSettings.runBudgetUsd);
  // Refresh also clears a previously assigned threshold when the policy stops setting it.
  merged.fallbackAfter = validFallbackAfter(localSettings.fallbackAfter) ? localSettings.fallbackAfter : remote.fallbackAfter;
  return merged;
}

export function readCache(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

function writeCache(file, policy, now) {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ ...policy, fetchedAt: now() })); } catch {}
}

async function withTimeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]); } finally { clearTimeout(timer); }
}

// Returns { policy, source } and never throws. `source` is 'remote', 'cache' or 'community'.
export async function loadPolicy({ apiUrl, apiKey, cacheFile, agent, host = 'openbot', fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 1500 } = {}) {
  const cached = cacheFile ? readCache(cacheFile) : null;
  if (cached && cached.ttlSeconds > 0 && now() - (cached.fetchedAt || 0) < cached.ttlSeconds * 1000) return { policy: cached, source: 'cache' };
  if (!apiUrl || !apiKey || !fetchImpl) return cached ? { policy: cached, source: 'cache' } : { policy: COMMUNITY_POLICY, source: 'community' };
  try {
    const url = new URL('/v1/policy', apiUrl);
    url.searchParams.set('protocol', PROTOCOL); url.searchParams.set('connector', CONNECTOR_VERSION); url.searchParams.set('host', host);
    if (agent) url.searchParams.set('agent', agent);
    const res = await withTimeout(fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` } }), timeoutMs);
    if (!res.ok) throw new Error(`policy ${res.status}`);
    const body = await res.json();
    if (body?.protocol !== PROTOCOL || typeof body.rules !== 'object') throw new Error('policy protocol mismatch');
    const policy = { id: String(body.id || 'remote'), protocol: PROTOCOL, source: 'remote', ttlSeconds: Number(body.ttlSeconds) || 300, rules: sanitizeRules(body.rules) };
    if (cacheFile) writeCache(cacheFile, policy, now);
    return { policy, source: 'remote' };
  } catch {
    return cached ? { policy: cached, source: 'cache' } : { policy: COMMUNITY_POLICY, source: 'community' };
  }
}

// Only these fields leave the machine. Everything else in an event is dropped here.
const EVENT_FIELDS = ['at', 'type', 'kind', 'rule', 'tool', 'costUsd', 'messages', 'over', 'count', 'missing', 'exit', 'files'];
export function scrubEvent(event) {
  const out = {};
  for (const key of EVENT_FIELDS) if (event[key] !== undefined) out[key] = key === 'tool' ? String(event.tool).replace(/^mcp__[^_]+(_[0-9a-f]+)?__/, 'mcp:') : event[key];
  return out;
}

// Fire and forget: telemetry never delays or fails the agent.
export async function sendEvents({ apiUrl, apiKey, agent, policyId, events, fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  if (!apiUrl || !apiKey || !fetchImpl || !events?.length) return false;
  try {
    const res = await withTimeout(fetchImpl(new URL('/v1/events', apiUrl), {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: PROTOCOL, connector: CONNECTOR_VERSION, agent, policyId, events: events.map(scrubEvent) }),
    }), timeoutMs);
    return res.ok;
  } catch { return false; }
}
