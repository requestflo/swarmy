/**
 * The registry's GC maintenance window (PURE spec builders; unit-tested).
 *
 * registry:2's documented safe procedure: restart the registry with
 * `storage.maintenance.readonly.enabled: true`, run `garbage-collect`, restart
 * it read-write. Read-only keeps every PULL working (deploys, reschedules,
 * fresh nodes) and refuses pushes, so a blob uploaded mid-sweep can never be
 * collected. The env form is `REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}`.
 *
 * Both restarts are pinned (`node.id==<the node running the registry task>`):
 * the registry's volume is node-local, so a task Swarm re-placed elsewhere
 * would come up on an empty volume. The pin stays after the window — the
 * registry belongs on the node that holds its data. Specs are the same
 * `registryServiceSpec` the auth converge deploys (same htpasswd secret, the
 * mirror labels carried), so the converge check stays green afterwards.
 */
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { mirrorLabelsOf } from '@swarmy/core/system-images';
import { REGISTRY_AUTH_LABEL, registryServiceSpec } from './registry-auth';
import { liveRegistryTopology, type LiveNetworking, type RegistryTopology } from './registry-topology';

export const REGISTRY_READONLY_ENV = 'REGISTRY_STORAGE_MAINTENANCE_READONLY';
export const REGISTRY_READONLY_VALUE = '{"enabled":true}';
/** Present on the registry service only while a GC window holds it read-only. */
export const REGISTRY_MAINTENANCE_LABEL = 'swarmy.registry.maintenance';
export const REGISTRY_DATA_TARGET = '/var/lib/registry';
const DEFAULT_REGISTRY_VOLUME = 'swarmy-registry-data';

type LiveRegistry = Pick<SwarmServiceInfo, 'env' | 'labels' | 'mounts'>;

/** Is the live registry (still) in a GC window? */
export function registryIsReadOnly(live: LiveRegistry): boolean {
  return live.env.some((e) => e.startsWith(`${REGISTRY_READONLY_ENV}=`)) || REGISTRY_MAINTENANCE_LABEL in live.labels;
}

/**
 * The named volume holding the registry's filesystem storage, or null when GC
 * can't run against it here (another storage driver, or a bind/tmpfs mount).
 * An agent too old to report mounts reads as the spec's default volume.
 */
export function registryDataVolume(live: LiveRegistry): string | null {
  const driver = live.env.find((e) => e.startsWith('REGISTRY_STORAGE='))?.slice('REGISTRY_STORAGE='.length);
  if (driver && driver !== 'filesystem') return null;
  if (!live.mounts) return DEFAULT_REGISTRY_VOLUME;
  const m = live.mounts.find((x) => x.target === REGISTRY_DATA_TARGET);
  return m && (m.type ?? 'volume') === 'volume' && m.source ? m.source : null;
}

/**
 * The registry spec for one side of the window: `readOnly` adds the env +
 * label, both sides pin to `swarmNodeId` and stop the old task before the new
 * one starts. Null when the live registry carries no htpasswd login (the auth
 * converge must run first) or the node id isn't a swarm id.
 *
 * `topology` (M16) is the org's desired one (`registryTopologyFor`, carried on
 * the GC target); the default keeps whatever the live registry runs, so a
 * window never moves it on or off the routing mesh by accident. The topology
 * reconcile uses this same pinned, stop-first spec to move the registry.
 */
export function registryMaintenanceSpec(
  live: Pick<SwarmServiceInfo, 'labels'> & LiveNetworking,
  swarmNodeId: string,
  readOnly: boolean,
  topology: RegistryTopology = liveRegistryTopology(live),
): ServiceSpec | null {
  const secret = live.labels[REGISTRY_AUTH_LABEL];
  if (!secret || !/^[a-z0-9]+$/i.test(swarmNodeId)) return null;
  const base = registryServiceSpec(secret, mirrorLabelsOf(live.labels), topology);
  return {
    ...pinRegistryToNode(base, swarmNodeId),
    env: readOnly ? { ...base.env, [REGISTRY_READONLY_ENV]: REGISTRY_READONLY_VALUE } : base.env,
    labels: readOnly ? { ...base.labels, [REGISTRY_MAINTENANCE_LABEL]: 'gc' } : base.labels,
  };
}

/**
 * Pin a registry spec to the swarm node holding its volume, stopping the old
 * task first (the node-local volume can't be shared by two tasks on two
 * nodes). Unchanged when the node isn't known or isn't a swarm id.
 */
export function pinRegistryToNode(spec: ServiceSpec, swarmNodeId: string | null | undefined): ServiceSpec {
  if (!swarmNodeId || !/^[a-z0-9]+$/i.test(swarmNodeId)) return spec;
  return { ...spec, placement: { constraints: [`node.id==${swarmNodeId}`] }, updateConfig: { order: 'stop-first' } };
}
