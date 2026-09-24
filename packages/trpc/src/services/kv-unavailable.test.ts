/**
 * "kv unavailable ≠ empty": while an org's swarm-kv can't be read (controller
 * just booted, no manager agent dialled in yet), nothing may treat the missing
 * documents as "nothing configured" and converge the swarm to that — no empty
 * Caddyfile, no removed DNS service, no torn-down store. Readers either fail
 * (NO_MANAGER) or the worker skips the org this tick.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentHub } from '../hub/types';
import { geoDnsEnabledOrgIds } from './geodns.service';
import { geoDnsConfigRepo } from './geodns.repo';
import { reconcileIngressOrg } from './ingress.service';
import { ingressConfigRepo, ingressEnabledOrgIds } from './ingress-config.repo';
import { storageClusterRepo } from './storage-cluster.repo';
import { useHubKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ||= 'kv-unavailable-test-key';

const ORG = 'org_boot';

/** A controller that just booted: the org has enrolled nodes, but no manager agent is connected. */
function bootingController() {
  const dispatched: string[] = [];
  const hub = {
    managerNode: () => undefined,
    managerNodes: () => [],
    isOnline: () => false,
    liveInventory: () => ({ services: [], containers: [] }),
    nodeInventory: () => [],
    nodeInfoFor: () => undefined,
    latestContainers: () => [],
    dispatch: async (_n: string, cmd: string) => {
      dispatched.push(cmd);
      throw new Error('node offline');
    },
  } as unknown as AgentHub;
  useHubKv(hub); // the production driver: config.* via a manager agent
  const db = {
    node: { count: async () => 2, findMany: async () => [{ id: 'n1' }, { id: 'n2' }] },
    organization: { findMany: async () => [{ id: ORG }] },
    statusPage: { findMany: async () => [] },
    inboundEndpoint: { findMany: async () => [] },
    auditLog: { create: async () => ({}) },
  } as never;
  return { hub, db, dispatched };
}

describe('swarm-kv unavailable is never "no config"', () => {
  test('repository reads fail with NO_MANAGER instead of returning defaults', async () => {
    const { hub, db } = bootingController();
    const err = await ingressConfigRepo.get({ hub, db }, ORG).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('PRECONDITION_FAILED');
    expect(await storageClusterRepo.find({ hub, db }, ORG).catch(() => 'threw')).toBe('threw');
    expect(await geoDnsConfigRepo.get({ hub, db }, ORG).catch(() => 'threw')).toBe('threw');
  });

  test('the ingress reconcile renders and dispatches nothing', async () => {
    const { hub, db, dispatched } = bootingController();
    const res = await reconcileIngressOrg({ hub, db, auth: {} as never }, ORG).catch((e: unknown) => ({ error: e }));
    expect('error' in (res as object)).toBe(true);
    expect(dispatched.filter((c) => !c.startsWith('config.'))).toEqual([]); // no edge deploy/apply
  });

  test('workers skip the org this tick (no manager ⇒ not in the work list)', async () => {
    const { hub, db, dispatched } = bootingController();
    expect(await geoDnsEnabledOrgIds({ hub, db })).toEqual([]);
    expect(await ingressEnabledOrgIds({ hub, db })).toEqual([]);
    expect(await storageClusterRepo.listAll({ hub, db })).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  test('an org with no enrolled node has no swarm: its store is honestly empty', async () => {
    const { hub } = bootingController();
    const db = { node: { count: async () => 0 } } as never;
    expect((await ingressConfigRepo.get({ hub, db }, 'org_fresh')).driver).toBe('CADDY');
    expect(await storageClusterRepo.find({ hub, db }, 'org_fresh')).toBeNull();
  });
});
