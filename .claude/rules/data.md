---
paths:
  - 'packages/trpc/src/routers/{manageddb,cache,search,vector,buckets,bucket-rules,storage}.ts'
  - 'packages/trpc/src/services/{manageddb,cache,search,vector,buckets,storage}*'
  - 'apps/agent/src/handlers/storage.ts'
  - 'apps/api/src/workers/*-reconcile.ts'
---

# Managed data and state

Load `managed-data-services`; for where any config or state lives, `docker-native-storage`;
for a worker, `reconcile-workers`.

- BR-003, DR-005: state lives on Docker labels, configs and secrets; the database holds
  only identity, access, audit and history.
- DR-028: failover promotes only a copy proven caught up; otherwise it holds for an admin.
- DR-029: object storage is Garage.
- DR-030: volumes use engine-native copies and moves; ext4 only, never auto-format.
- DR-031: queues are a convention over a managed cache.
