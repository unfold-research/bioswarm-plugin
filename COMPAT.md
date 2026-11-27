# Compatibility

Connector 0.3.1 · bioswarm.v1 · checked 2026-11-26 UTC.

| Host | Channel | Version | Observed result |
|---|---|---|---|
| Pi | pinned | 1.5.2 | passed Pi session and policy suite |
| Pi | latest | 1.6.1 | passed Pi session and policy suite |
| OpenBot | pinned | 0.78.0 | pending real Docker smoke |
| OpenBot | latest | 0.80.0 | pending real Docker smoke |

Pi uses real sessions with a fixture model. OpenBot requires a live Docker run with three agents and the current connector revision.
