# Business requirements: data and storage

Proposed capability records. "Built" says how far the code is: "Needs live run" means the code and unit tests exist but nobody has proved it on a real multi-node, multi-region swarm.

## BR-057

- Status: Proposed
- Revision: 1
- Built: Shipped

One form provisions Postgres (single, replica, failover, geo, active-active), Valkey, search and vectors; attaching wires env, a secret file and a network, and detaching undoes it.

## BR-058

- Status: Proposed
- Revision: 1
- Built: Needs live run

WHEN a primary database fails, THE SYSTEM SHALL auto-promote only a copy proven caught up; otherwise it holds, opens an incident showing the data-loss window, and waits for an admin.

## BR-059

- Status: Proposed
- Revision: 1
- Built: Shipped

A planned switchover loses no committed write and refuses before touching anything unless it is safe.

## BR-060

- Status: Proposed
- Revision: 1
- Built: Shipped

Database credentials show once and live only as Docker secrets.

## BR-061

- Status: Proposed
- Revision: 1
- Built: Shipped

Object storage is Garage on your own nodes; a bucket that holds objects or is attached can't be deleted.

## BR-062

- Status: Proposed
- Revision: 1
- Built: Shipped

Queue workers autoscale within their band; dead letters can be browsed and requeued.

## BR-063

- Status: Proposed
- Revision: 1
- Built: Shipped

Inbound webhooks are stored before they're trusted; bad signatures are refused and never queued; outbound events are signed and retried.

## BR-064

- Status: Proposed
- Revision: 1
- Built: Shipped

The controller runs no database server, only embedded SQLite.

## BR-065

- Status: Proposed
- Revision: 1
- Built: Needs live run

The controller can float between managers: replicated store, restore on boot, lease fence.

## BR-066

- Status: Proposed
- Revision: 1
- Built: Needs live run

Add a disk, move a volume, or retire a server through a readable plan and a resumable run.

## BR-067

- Status: Proposed
- Revision: 1
- Built: Partial: the per-server check isn't built

New managed Postgres gets a standby when 2+ servers are ready, and each server shows what you'd lose if it died.
