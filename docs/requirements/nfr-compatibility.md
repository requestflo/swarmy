# Non-functional requirements: compatibility

Quality targets under ISO/IEC 25010:2023 "Compatibility". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-034 · Mesh MTU

- Status: Proposed
- Revision: 1
- Target: Overlays at 1280; containers at 1230, or 1204 encrypted
- Checked by: MTU test; real swarm owed

## NFR-035 · Managers across regions

- Status: Proposed
- Revision: 1
- Target: At least 3 failure domains within about 100–150 ms of each other
- Checked by: None
