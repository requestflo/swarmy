/**
 * MeshConfig repository — swarm-kv `mesh/<orgId>` (P4 slice 1).
 *
 * Driver + control-plane config the mesh reconcile converges. The control
 * plane's service token is a vault blob inside `controlPlane` (and the whole
 * document is vault-sealed in raft). Peers are derived live, never stored.
 */
import { orgSingleton, type KvRow } from './kv-repo';

/** Mirrors the (removed) Prisma `MeshDriver` enum. */
export type MeshDriverEnum = 'NETBIRD' | 'HEADSCALE' | 'NONE';

export interface MeshConfigDoc {
  driver: MeshDriverEnum;
  enabled: boolean;
  managementUrl: string | null;
  controlPlane: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export type MeshConfigRow = KvRow<MeshConfigDoc>;

export const meshConfigRepo = orgSingleton<MeshConfigDoc>('mesh', () => ({
  driver: 'NONE',
  enabled: false,
  managementUrl: null,
  controlPlane: {},
  settings: {},
}));
