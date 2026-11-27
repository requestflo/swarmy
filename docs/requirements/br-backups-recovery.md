# Business requirements: backups and recovery

Proposed capability records. "Built" says how far the code is: "Needs live run" means the code and unit tests exist but nobody has proved it on a real multi-node, multi-region swarm.

## BR-068

- Status: Proposed
- Revision: 1
- Built: Shipped

Each app's Backups tab lists in plain words what isn't protected yet, each with a fix link and no score.

## BR-069

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN a backup destination exists, THE SYSTEM SHALL back up every database and named volume nightly, keep 7, and never override or re-create a schedule someone changed or opted out of.

## BR-070

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN an admin runs a restore drill, THE SYSTEM SHALL restore the latest backup into a throwaway cluster, check it, destroy it, show the measured RPO and RTO, and audit it.

## BR-071

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN a restore would overwrite live data, THE SYSTEM SHALL take a safety backup first and refuse if that fails.

## BR-072

- Status: Proposed
- Revision: 1
- Built: Shipped (no unit test)

WHEN a node holding a volume's data stays offline past about 5 min, THE SYSTEM SHALL restore the latest snapshot onto a healthy node.

## BR-073

- Status: Proposed
- Revision: 1
- Built: Shipped

Backup passwords and storage keys are vault-encrypted and reach a node only as process environment, never disk.

## BR-074

- Status: Proposed
- Revision: 1
- Built: Shipped

WHEN the controller is lost, THE SYSTEM SHALL restore it from a passphrase-sealed bundle, and agents re-adopt it without re-enrolling.

## BR-075

- Status: Proposed
- Revision: 1
- Built: Needs live run

Only one controller writes at a time; one that can't renew its lease stops writing.
