/**
 * Shared MeshConfig row builder for the two places that bootstrap mesh from
 * plain env vars: the self-host controller (`apps/api/src/bootstrap/seed.ts`)
 * and the local-dev seed (`scripts/seed-dev.ts`). Keeps the `controlPlane`
 * JSON shape in sync with what `mesh.service.ts`'s `toOrgConfig` expects
 * (`{ mode, url, serviceTokenEnc }`) regardless of which path wrote it.
 */
import { encryptSecret } from './crypto';

const MESH_DRIVERS = ['NETBIRD', 'HEADSCALE', 'NONE'] as const;
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

/** Structural twin of @swarmy/mesh `MeshControlTls` (core can't import mesh). */
export type MeshTlsMode =
  | { mode: 'letsencrypt'; email?: string }
  | { mode: 'edge'; listen: string; publicPort?: number }
  | { mode: 'none'; port: number };

/**
 * The installer → controller TLS contract (`SWARMY_MESH_TLS`), pure:
 *   `letsencrypt` | `none:<port>` | `edge=<listen>[@<public port>][;bootstrap=none:<port>]`
 * `bootstrap` is the mode NetBird boots in until the edge serves the mesh
 * domain (the TLS handover, QA-012).
 */
export function parseMeshTlsEnv(raw: string | undefined): { tls: MeshTlsMode; bootstrapTls?: MeshTlsMode } {
  const [main, ...rest] = (raw || 'letsencrypt').split(';');
  const one = (v: string): MeshTlsMode => {
    if (v.startsWith('none')) return { mode: 'none', port: Number(v.split(':')[1]) || 8081 };
    if (v.startsWith('edge')) {
      const [listen, port] = (v.split('=')[1] || '172.17.0.1:8081').split('@');
      const p = Number(port);
      return { mode: 'edge', listen: listen!, ...(p && p !== 443 ? { publicPort: p } : {}) };
    }
    return { mode: 'letsencrypt' };
  };
  const boot = rest.find((r) => r.startsWith('bootstrap='))?.slice('bootstrap='.length);
  return { tls: one(main!), ...(boot ? { bootstrapTls: one(boot) } : {}) };
}
