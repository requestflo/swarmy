/**
 * Shared MeshConfig row builder for the two places that bootstrap mesh from
 * plain env vars: the self-host controller (`apps/api/src/bootstrap/seed.ts`)
 * and the local-dev seed (`scripts/seed-dev.ts`). Keeps the `controlPlane`
 * JSON shape in sync with what `mesh.service.ts`'s `toOrgConfig` expects
 * (`{ mode, url, serviceTokenEnc }`) regardless of which path wrote it.
 */
import { encryptSecret } from './crypto';

const MESH_DRIVERS = ['NETBIRD', 'HEADSCALE', 'TAILSCALE', 'WIREGUARD', 'NONE'] as const;
export type MeshDriverName = (typeof MESH_DRIVERS)[number];

export interface MeshConfigRow {
  orgId: string;
  driver: MeshDriverName;
  enabled: true;
  managementUrl: string;
  controlPlane: { mode: 'external'; url: string; serviceTokenEnc: string };
}

/**
 * Build the MeshConfig upsert row from raw env-style inputs, or return null
 * when any input is missing/unrecognized — callers skip the upsert entirely,
 * preserving mesh's opt-in-by-absence behavior.
 */
export function buildMeshConfigRow(
  orgId: string,
  opts: {
    driver: string | undefined;
    managementUrl: string | undefined;
    serviceToken: string | undefined;
    onInvalidDriver?: (raw: string) => void;
  },
): MeshConfigRow | null {
  const { driver: driverRaw, managementUrl, serviceToken, onInvalidDriver } = opts;
  if (!driverRaw || !managementUrl || !serviceToken) return null;

  const driver = driverRaw.toUpperCase() as MeshDriverName;
  if (!(MESH_DRIVERS as readonly string[]).includes(driver)) {
    onInvalidDriver?.(driverRaw);
    return null;
  }

  return {
    orgId,
    driver,
    enabled: true,
    managementUrl,
    controlPlane: { mode: 'external', url: managementUrl, serviceTokenEnc: encryptSecret(serviceToken) },
  };
}
