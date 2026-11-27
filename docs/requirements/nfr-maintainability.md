# Non-functional requirements: maintainability

Quality targets under ISO/IEC 25010:2023 "Maintainability". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-039 · Swarm config budget

- Status: Proposed
- Revision: 1
- Target: At most 64 KB per document and 2 MB in all; warn at 75%, critical at 95%
- Checked by: Size test and watcher

## NFR-040 · Telemetry retention

- Status: Proposed
- Revision: 1
- Target: 7 days by default, settable from 1 to 365
- Checked by: None
