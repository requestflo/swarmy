# Non-functional requirements: reliability

Quality targets under ISO/IEC 25010:2023 "Reliability". Every number is already in swarmy's docs or code; "Checked by" says how far it is proven.

## NFR-010 · DNS region failover

- Status: Proposed
- Revision: 1
- Target: A dead region leaves answers within one reconcile tick (about 15 s) plus the TTL (about 30 s)
- Checked by: Unit test; live sweep owed

## NFR-011 · Domain go-live

- Status: Proposed
- Revision: 1
- Target: At least 3 of every 4 resolvers agree, including 1.1.1.1 and 8.8.8.8
- Checked by: Domain-verify test

## NFR-012 · Database failover

- Status: Proposed
- Revision: 1
- Target: Auto-promote only when replay LSN ≥ the primary's last flushed LSN; about 30 s grace
- Checked by: Failover tests; live drill owed

## NFR-013 · Planned switchover

- Status: Proposed
- Revision: 1
- Target: Refuses unless the copy is within one WAL segment; a stuck run undoes itself after 10 min
- Checked by: Switchover test

## NFR-014 · Controller data loss

- Status: Proposed
- Revision: 1
- Target: About 1 s when its node dies; none on a clean stop or move
- Checked by: Lag test; drain drill unrun

## NFR-015 · Controller failover

- Status: Proposed
- Revision: 1
- Target: About 70 s after its node dies
- Checked by: Fence-drill test; partition drill unrun

## NFR-016 · Single-writer fence

- Status: Proposed
- Revision: 1
- Target: Lease renews every 10 s; a holder that can't renew stops writing at 52 s (the plan said 30 s)
- Checked by: Lease test; open decision DR-041

## NFR-017 · Mesh control-plane move

- Status: Proposed
- Revision: 1
- Target: Back within 5 min, losing about 1 s of data
- Checked by: Drill scripted, never run

## NFR-018 · Default backups

- Status: Proposed
- Revision: 1
- Target: Nightly, keep 7; critical alert after 7 days with no good backup
- Checked by: Auto-backup and resilience tests

## NFR-019 · Volume recovery

- Status: Proposed
- Revision: 1
- Target: Restore onto a healthy node after about 5 min offline; data loss up to one backup interval
- Checked by: None

## NFR-020 · Deploy health gate

- Status: Proposed
- Revision: 1
- Target: Window 30–3,600 s (default 120 s); no signal passes after twice the window
- Checked by: Schema and worker tests

## NFR-021 · Disk-full forecast

- Status: Proposed
- Revision: 1
- Target: Warn under 14 days to full, critical under 3 days; Postgres guard at 90%
- Checked by: Forecast tests

## NFR-022 · Object storage copies

- Status: Proposed
- Revision: 1
- Target: 3 copies by default, or one per storage node when there are fewer
- Checked by: Storage reconcile test

## NFR-023 · Certificate expiry

- Status: Proposed
- Revision: 1
- Target: Warning under 14 days, critical under 3 days or failing renewal
- Checked by: Default alert rule
