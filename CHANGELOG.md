# Changelog

The plugin was developed as `packages/connector-pi` in the BioSwarm monorepo and published as its own repository on the open research release. Earlier entries are kept as they were written.

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
