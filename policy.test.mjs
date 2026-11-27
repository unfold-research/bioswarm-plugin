// The policy client against a fake Control API: no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMUNITY_POLICY, loadPolicy, mergeConfig, PROTOCOL, scrubEvent, sendEvents } from './policy.js';

const cacheFile = () => join(mkdtempSync(join(tmpdir(), 'bioswarm-policy-')), 'policy.json');
const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

test('without a key the community policy runs and nothing is fetched', async () => {
  let called = false;
  const { policy, source } = await loadPolicy({ apiUrl: 'https://api.example', cacheFile: cacheFile(), fetchImpl: async () => { called = true; } });
  assert.equal(source, 'community'); assert.equal(policy, COMMUNITY_POLICY); assert.equal(called, false);
});

test('a remote policy is used, cached, and stripped of keys it may not set', async () => {
  const file = cacheFile();
  const { policy, source } = await loadPolicy({ apiUrl: 'https://api.example', apiKey: 'k', cacheFile: file,
    fetchImpl: reply(200, { protocol: PROTOCOL, id: 'p-7', ttlSeconds: 60, rules: { messagesPerRun: 2, shell: 'rm -rf /' } }) });
  assert.equal(source, 'remote'); assert.equal(policy.id, 'p-7'); assert.deepEqual(policy.rules, { messagesPerRun: 2 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, 'p-7');
  const again = await loadPolicy({ apiUrl: 'https://api.example', apiKey: 'k', cacheFile: file, fetchImpl: async () => { throw new Error('should use cache'); } });
  assert.equal(again.source, 'cache');
});

test('an unreachable or incompatible API falls back without throwing', async () => {
  const down = await loadPolicy({ apiUrl: 'https://api.example', apiKey: 'k', cacheFile: cacheFile(), fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(down.source, 'community');
  const wrong = await loadPolicy({ apiUrl: 'https://api.example', apiKey: 'k', cacheFile: cacheFile(), fetchImpl: reply(200, { protocol: 'bioswarm.v0', rules: {} }) });
  assert.equal(wrong.source, 'community');
  const slow = await loadPolicy({ apiUrl: 'https://api.example', apiKey: 'k', cacheFile: cacheFile(), timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  assert.equal(slow.source, 'community');
});

test('the local budget can only lower the remote one', () => {
  assert.equal(mergeConfig({ runBudgetUsd: 5 }, { runBudgetUsd: 2 }).runBudgetUsd, 2);
  assert.equal(mergeConfig({ runBudgetUsd: 1 }, { runBudgetUsd: 9 }).runBudgetUsd, 1);
});

test('telemetry carries counts and costs, never text', async () => {
  assert.deepEqual(scrubEvent({ at: 1, type: 'tool', tool: 'mcp__openbot_5b4cb186__send_message', text: 'secret', path: '/Users/x' }), { at: 1, type: 'tool', tool: 'mcp:send_message' });
  let body;
  const ok = await sendEvents({ apiUrl: 'https://api.example', apiKey: 'k', agent: 'a', policyId: 'p', events: [{ type: 'run_end', costUsd: 0.1, message: 'hi' }],
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true }; } });
  assert.equal(ok, true); assert.deepEqual(body.events, [{ type: 'run_end', costUsd: 0.1 }]);
  assert.equal(await sendEvents({ apiUrl: 'https://api.example', events: [{ type: 'x' }] }), false);
});

test('the received threshold changes the recovery wave and withdrawing it restores the wave default', async () => {
  const { assignment } = await import('./coordination.js');
  const wave = { run: 'run', wave: 2, fallbackAfter: 3, team: ['owner', 'peer', 'helper'] };
  const check = { id: 'balance', owners: ['owner'], loneWaves: 2 };
  const rules = { waitForTrace: true, tieBreak: 'hash' };
  const fetchPolicy = async (fallbackAfter) => {
    const { source, policy } = await loadPolicy({ apiUrl: 'https://api.example', apiKey: 'fixture',
      fetchImpl: reply(200, { protocol: PROTOCOL, id: 'study', rules: { ...rules, fallbackAfter } }) });
    assert.equal(source, 'remote');
    return policy.rules;
  };
  const remote = await fetchPolicy(2);
  const cfg = mergeConfig(remote);
  const early = assignment(wave, check, cfg);
  assert.equal(early.fallback, true);
  assert.notEqual(early.agent, 'owner');
  assert.deepEqual(assignment({ ...wave, wave: 3 }, { ...check, loneWaves: 3 }, cfg), early);
  assert.equal(assignment(wave, check, mergeConfig(remote, { fallbackAfter: 4 })).fallback, false);
  for (const invalid of [undefined, null, 1, 2.5, '2']) {
    Object.assign(cfg, mergeConfig(await fetchPolicy(invalid)));
    assert.equal(assignment(wave, check, cfg).fallback, false);
    assert.equal(assignment({ ...wave, wave: 3 }, { ...check, loneWaves: 3 }, cfg).fallback, true);
  }
});
