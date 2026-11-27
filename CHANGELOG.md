# Changelog

The plugin was developed as `packages/connector-pi` in the BioSwarm monorepo and published as its own repository on the open research release. Earlier entries are kept as they were written.

## Plugin 0.4.0 · pre-release

- The community policy (no key) turns the hash tie-break on and keeps trace waiting off. Trace waiting stays available as an explicit experimental opt-in. A remote policy that omits the two switches keeps them off instead of inheriting the community values.
- The community tie-break binds only once a wave is published, so an agent without a wave runner keeps its normal tools. A policy or local marker that sets a switch binds as before.
- Stalled-check recovery no longer needs trace waiting: with hash arbitration, a single check unchanged for `fallbackAfter` waves goes to an agent outside its owners, who can write without a trace. A wave without `fallbackAfter` uses 3. The experimental scoped trace contract still keeps a lone `own` check with its owner.

## Connector 0.3.1

Restore the 0.2 yield behavior for hash-only coordination on class-aware waves. Control recommends the shared field and hash tie-break. Trace waiting remains an explicit experimental policy.


## Connector 0.3.0 · pre-release

- Class-aware waves restrict mandatory traces to directed dependencies. Symmetric contenders elect one writer. Sole owners can write immediately and see addressed traces as priorities. Legacy wave publishers retain 0.2 behavior.
- A local decision receipt records the check, class, wave, tool and outcome. Control receives the existing count-only telemetry.

## Connector 0.2.0 · pre-release

- Enforce addressed requirement traces and hashed contention inside Pi's tool loop for locally declared checks.
- Reassign a single unchanged check to an outsider after a configurable number of observed waves. Control can set `fallbackAfter` per agent or workspace.
- Add a local observation publisher, agent assignment tool, Pi session tests and a direct OAuth smoke.

## 0.1.0 (2026-11-25), pre-release

- `@unfold/bioswarm-pi`: connector for Pi agents and OpenBot agents on Pi, ported from Unfold Research's tested
  extension (`experiments/openbot-unfold-mode`): shared field, message ceilings and pointer rule, taken files,
  spending ceiling, acceptance gate, event record. New: remote policy from the Control API with cache and community
  fallback; telemetry with counts and costs only.
- `@unfold/bioswarm`: SDK for policies, runs and metrics.
- Protocol `bioswarm.v1`.
