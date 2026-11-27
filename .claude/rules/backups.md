---
paths:
  - 'packages/trpc/src/services/*ackup*'
  - 'packages/trpc/src/services/resilience*'
  - 'apps/agent/src/handlers/backup.ts'
  - 'apps/api/src/workers/*backup*'
---

# Backups and recovery

Load `backups-dr` before editing.

- DR-032: restic, with one destination type for volumes, databases and the controller.
- DR-033: the controller backup passphrase is held by the founder; escrow is opt-in.
- DR-034: resilience is a list of what isn't protected, never a score.
- DR-035: drills restore into a throwaway cluster and show measured RPO and RTO.
- BR-008: a restore over live data takes a safety backup first.
