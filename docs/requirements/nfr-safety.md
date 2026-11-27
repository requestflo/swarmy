# Non-functional requirements: safety

Quality targets under ISO/IEC 25010:2023 "Safety". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-033 · Moving a volume

- Status: Proposed
- Revision: 1
- Target: Snapshot first if the newest is over 24 h old; destination stays under 85% full; old copy kept 7 days
- Checked by: Decommission planner tests
