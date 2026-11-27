# Non-functional requirements: performance efficiency

Quality targets under ISO/IEC 25010:2023 "Performance efficiency". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-001 · Controller footprint

- Status: Proposed
- Revision: 1
- Target: Runs on a 1 GB VPS at under 250 MiB steady memory
- Checked by: Never measured on SQLite; 284 MiB on the old store

## NFR-002 · First node with the mesh

- Status: Proposed
- Revision: 1
- Target: 650–750 MiB of 1 GB in use; NetBird server about 105 MiB idle
- Checked by: 1 GB re-measure on DigitalOcean owed

## NFR-003 · Policy decision

- Status: Proposed
- Revision: 1
- Target: Under 1 ms per decision
- Checked by: CI checks correctness only, not speed

## NFR-004 · Degraded threshold

- Status: Proposed
- Revision: 1
- Target: A service counts as degraded at p95 above 1,500 ms or errors above 5%
- Checked by: Health-summary tests

## NFR-005 · Geo-DNS answer lifetime

- Status: Proposed
- Revision: 1
- Target: 30 s TTL by default
- Checked by: None

## NFR-006 · Build cache

- Status: Proposed
- Revision: 1
- Target: Unused entries kept 14 days, capped at 20 GB
- Checked by: Cache GC test

## NFR-007 · Node disk hygiene

- Status: Proposed
- Revision: 1
- Target: Every 6 h (sooner past 85% full): images unused 7 days, build cache over 5 GB, logs 10 MB × 3, journald 500 MB
- Checked by: None

## NFR-008 · Idle sleep

- Status: Proposed
- Revision: 1
- Target: Apps sleep after 300 s idle; previews sleep after 2 h and expire after 72 h
- Checked by: Scale-to-zero test

## NFR-009 · Queue scale-down

- Status: Proposed
- Revision: 1
- Target: 600 s cooldown
- Checked by: Autoscale test
