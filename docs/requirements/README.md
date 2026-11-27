# Requirements

What swarmy must do (`BR-NNN`) and how well it must do it (`NFR-NNN`). The record system,
the statuses and the rules for changing a record are in
[`../decisions/README.md`](../decisions/README.md) (DR-001); every record is listed in
[`../RECORDS.md`](../RECORDS.md).

BR-098 is the paramount rule: swarmy is configurable by default. When another requirement
pulls against it, BR-098 wins unless a decision record says why not.

## Files

| File                                                           | Holds                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| [`br-configuration.md`](br-configuration.md)                   | BR-098 to BR-105: configurable by default (Accepted)            |
| [`br-principles.md`](br-principles.md)                         | BR-001 to BR-016: the promises every feature keeps (Accepted)   |
| [`br-nodes-deploys-builds.md`](br-nodes-deploys-builds.md)     | Capabilities: nodes, deploys and builds                         |
| [`br-edge-ingress-mesh.md`](br-edge-ingress-mesh.md)           | Capabilities: edge, ingress and mesh                            |
| [`br-data-storage.md`](br-data-storage.md)                     | Capabilities: data and storage                                  |
| [`br-backups-recovery.md`](br-backups-recovery.md)             | Capabilities: backups and recovery                              |
| [`br-access-identity-safety.md`](br-access-identity-safety.md) | Capabilities: access, identity and safety                       |
| [`br-observability-ai.md`](br-observability-ai.md)             | Capabilities: observability and AI                              |
| `nfr-<characteristic>.md`                                      | Quality targets, one file per ISO/IEC 25010:2023 characteristic |

## Record format

```markdown
## BR-106 · Short title

- Status: Proposed
- Revision: 1
- Built: Not started

WHEN <trigger>, THE SYSTEM SHALL <response>.
```

Each record is a `##` heading with its ID (and an optional `· title`), a list of fields
(`Status` and `Revision` are required), then the requirement itself. NFRs carry `Target` and
`Checked by` fields. Add `Verified by: <test file or monitor>` once a test or monitor proves
the record; the records check reports Accepted records that have none.

## Qualities with no target yet

These matter to users, but no doc or test sets a number. Each needs a proposed NFR, then a
measurement on real machines.

- Time from pasting the install line to the node showing online
- Time from push to live, and how long a rollback takes
- Build duration and queue wait (one build per builder node today)
- How fast the controller marks an agent offline, and the agent's reconnect ceiling
- End-to-end database failover time, including rolling the apps onto the new writer
- Restore-drill and controller-restore times (measured and shown, with no target)
- Upgrade run length and downtime per component (only Garage's 1–2 min is stated)
- Edge latency SLO, and swarmy-dns query capacity
- Memory and disk budget for the telemetry store, and how long audit logs and session
  replays are kept
- Availability of the collector, the registry and public status pages
- Time from an alert firing to the message arriving
- Latency the AI gateway adds per call
