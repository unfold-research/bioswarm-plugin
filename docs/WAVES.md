# Local wave coordination

A task runner describes which files are open for work and which agents share responsibility for each check. It evaluates the checks after all active agents settle. A wave is one such observation. The Control API supplies the switches; the runner keeps the team, file names, checks and their evidence on the machine.

Give the team a fresh shared field per task. The default observation directory is `waves` inside that field. A local `.bioswarm` may set `waveDir` explicitly. Agent identifiers are the basenames of their Pi workspace directories. Publish the first observation before dispatch. Example input (replace the paths and identifiers with those of the local task):

```json
{"run":"nov-close","wave":1,"root":"/data/task","team":["orders","refunds","review"],"fallbackAfter":3,"checks":[{"id":"settlement","place":"settlement.txt","owners":["orders","refunds"],"revision":"difference-42"}]}
```

```sh
npx bioswarm-pi wave /data/field/waves observation.json
```

Use a canonical absolute root and regular files beneath it. The parent directory of a new file must exist. A check has one writable file and one or more eligible owners. Supply one entry per file. An empty checks array closes all managed work. Increment the wave only after an actual work opportunity and an independent evaluation. Keep the same `revision` while the observable failure is unchanged; change it when there is progress. Each wave is immutable. A new task gets a new directory.

Agents call `coordination_status` to see the assigned writer and trace status. Another team member calls `leave_mark` with `kind: "requirement"`, the file path in `place`, the writer's agent ID in `to`, and the requirement in `text`. This local field operation consumes no message allowance. The writer can act as soon as the mark arrives. Marks survive later waves while the same check, owners, place and revision remain continuously active.

For a contested file the highest SHA-256 score over run, wave, check and agent wins. A denied contender leaves one yield mark per wave. With hash arbitration enabled (the community default since 0.4, with or without trace waiting), when exactly one unchanged check remains for `fallbackAfter` consecutive observations, an agent outside its owner set takes over. A wave published without `fallbackAfter` uses 3. The runner must dispatch the new actor. Under hash alone that actor can write at once; with experimental trace waiting, a peer addresses the requirement to that actor, who can then write. If the team contains no outsider, the assigned owner retains responsibility. The threshold of three in these examples is an engineering choice without a measured optimum. To set the threshold through Control, assign the same `overrides: { fallbackAfter: 3 }` to each participating agent and use the received rules when calling `assignment` in the runner. A valid local marker value has precedence. An absent or invalid remote threshold leaves the wave default in effect unless the local marker sets one.

The Pi hook permits scoped `write` and `edit` for the assigned file. A missing wave, wrong recipient, self-issued trace, stale revision or uncovered file blocks the change. Read tools, field operations and recognized team messages stay available. Shell and opaque mutating tools cannot declare a single affected file and are blocked in coordinated mode. The runner executes independent checks between settled waves. The runner and local observation directory are trusted; third-party extensions and out-of-band writes are outside this coordination contract. With both switches off, the normal community tool behavior applies. The community policy turns hash arbitration on but binds only once a wave is published in the wave directory; a policy or local marker that sets either switch binds immediately.

`node bench/pi-direct.mjs` in the [BioSwarm monorepo](https://github.com/unfold-research/bioswarm) runs a short, synthetic technical check using Pi directly, a local OpenAI OAuth sign-in and three isolated workspaces. It prints aggregate counters and removes the scratch task. The OpenBot 0.1 study uses its frozen checkout. Do not use the 0.2 smoke as a 0.1 benchmark observation.


## Class-aware waves (connector 0.3)

With the default hash-only Control policy, the 0.2 writer and yield rules also apply to class-aware waves. All teammates who attempt another writer’s file yield once per wave. The winner can write without a requirement. The table below describes the experimental trace policy.

Set `coordination: "scoped-v1"` when publishing every wave in a run, with one explicit class per check. The publisher rejects an unknown class, inconsistent owner count, or a change of mode during the run. Omitting the header keeps the original rules. A change of class invalidates old requirements for that check.

| Class | Eligible writers | Write permission with waitForTrace + hash |
|---|---|---|
| own | One owner | Immediate. An addressed trace sets priority in coordination_status. |
| directed | One owner | This file requires a matching addressed requirement for the assigned writer. Other files remain actionable in the same turn. |
| dispute | At least two listed contenders | The hash picks one contender per wave. Other contenders yield once per wave. The winner may write immediately. |

The last-check fallback can appoint an outsider for a stalled check at the policy threshold. Under hash alone this includes a sole own check; with experimental trace waiting a sole own check keeps its owner, as in 0.3. Reads, the status tool and field tools remain available. A scoped write or edit emits a local `decision` with the wave, check ID, class, tool, rule and outcome. An allowed decision precedes tool execution. Use the host tool result to confirm the write succeeded. Control receives no decision events, check IDs or file names.
