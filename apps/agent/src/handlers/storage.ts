/**
 * Storage & volume orchestration handlers (epic: volumes-dr, P2+).
 *
 * `applyStorageNode` brings up a swarmy-managed object-store member (Garage):
 * write the rendered config files, deploy/update the store swarm service, then
 * apply the cluster layout via the admin API. Mirrors the ingress apply path.
 *
 * `provisionVolume`/`removeVolume` create or drop a Docker volume — a plain
 * `local` volume, or a Swarm CSI *cluster* volume. We only orchestrate an
 * already-installed CSI plugin; we do not ship a driver.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';

// NOTE: the canonical Zod schemas live in `@swarmy/core/protocol/storage` (new
// file, registered in the protocol index/union via the INTEGRATION snippets).
// Until that wiring lands, the agent uses these structural types so the handler
// builds standalone. They are kept in lockstep with the Zod schemas.
interface StorageFile {
  path: string;
  contents: string;
  mode?: number;
}
interface RenderedStoreDeployment {
  driver: 'garage' | 'minio' | 'none';
  files: StorageFile[];
  serviceName: string;
  image: string;
  s3Port: number;
  adminPort?: number;
  /** Extra labels the agent merges onto the store service's `labels` (see the Zod schema). */
  labels?: Record<string, string>;
  adminApi?: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
    url: string;
    body?: string;
    contentType?: string;
    bearerToken?: string;
  };
  summary: string;
}
interface ApplyStorageNodePayload {
  commandId: string;
  rendered: RenderedStoreDeployment;
}
interface ApplyStorageNodeResult {
  driver: string;
  serviceId: string;
  layoutApplied: boolean;
}
type VolumeAccessMode = 'single-writer' | 'multi-writer' | 'multi-reader';
interface VolumeSpec {
  name: string;
  mode: 'local' | 'cluster';
  csiDriver?: string;
  accessMode: VolumeAccessMode;
  capacityBytes?: number;
  options: Record<string, string>;
}
interface ProvisionVolumePayload {
  commandId: string;
  spec: VolumeSpec;
}
interface ProvisionVolumeResult {
  name: string;
  mode: 'local' | 'cluster';
  created: boolean;
}
interface RemoveVolumePayload {
  commandId: string;
  name: string;
  cluster: boolean;
}

export async function applyStorageNode(
  docker: DockerClient,
  p: ApplyStorageNodePayload,
): Promise<ApplyStorageNodeResult> {
  const r = p.rendered;
  for (const file of r.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { mode: file.mode ?? 0o600 });
  }

  // Deploy/update the store member as a swarm service via the existing helpers.
  const spec = {
    name: r.serviceName,
    image: r.image,
    mode: { replicated: { replicas: 1 } },
    // `r.labels` carries controller-side additions (e.g. the swarmy-system
    // stack namespace) layered over the agent's own base labels.
    labels: {
      'swarmy.managed': 'true',
      'swarmy.component': 'storage',
      'swarmy.driver': r.driver,
      ...r.labels,
    },
    ports: [
      { target: r.s3Port, protocol: 'tcp' as const, mode: 'ingress' as const },
      ...(r.adminPort
        ? [{ target: r.adminPort, protocol: 'tcp' as const, mode: 'ingress' as const }]
        : []),
    ],
    mounts: [
      { type: 'volume' as const, source: `${r.serviceName}-meta`, target: '/var/lib/garage/meta' },
      { type: 'volume' as const, source: `${r.serviceName}-data`, target: '/var/lib/garage/data' },
      ...(r.files.length
        ? [
            {
              type: 'bind' as const,
              source: r.files[0]!.path,
              target: '/etc/garage.toml',
              readOnly: true,
            },
          ]
        : []),
    ],
  };

  let serviceId = '';
  const existing = await docker.getServiceByName(spec.name);
  if (!existing) {
    serviceId = await docker.createService(spec);
  } else {
    const inspect = await existing.inspect();
    serviceId = inspect.ID;
  }

  let layoutApplied = false;
  if (r.adminApi) {
    const res = await fetch(r.adminApi.url, {
      method: r.adminApi.method,
      body: r.adminApi.body,
      headers: {
        ...(r.adminApi.contentType ? { 'content-type': r.adminApi.contentType } : {}),
        ...(r.adminApi.bearerToken ? { authorization: `Bearer ${r.adminApi.bearerToken}` } : {}),
      },
    }).catch(() => undefined);
    layoutApplied = Boolean(res?.ok);
  }

  return { driver: r.driver, serviceId, layoutApplied };
}

export async function provisionVolume(
  docker: DockerClient,
  p: ProvisionVolumePayload,
): Promise<ProvisionVolumeResult> {
  const { spec } = p;
  const d = docker.docker;

  // Idempotent: if it already exists, report created=false.
  const existing = await d.getVolume(spec.name).inspect().then(() => true).catch(() => false);
  if (existing) return { name: spec.name, mode: spec.mode, created: false };

  if (spec.mode === 'cluster') {
    if (!spec.csiDriver) throw new Error('cluster volume requires a csiDriver');
    const accessMode =
      spec.accessMode === 'multi-writer'
        ? { Scope: 'multi', Sharing: 'all' }
        : spec.accessMode === 'multi-reader'
          ? { Scope: 'multi', Sharing: 'readonly' }
          : { Scope: 'single', Sharing: 'none' };
    await d.createVolume({
      Name: spec.name,
      Driver: spec.csiDriver,
      ClusterVolumeSpec: {
        AccessMode: {
          ...accessMode,
          MountVolume: {},
        },
        ...(spec.capacityBytes
          ? { CapacityRange: { RequiredBytes: spec.capacityBytes } }
          : {}),
      },
      DriverOpts: spec.options,
    } as unknown as Parameters<typeof d.createVolume>[0]);
  } else {
    await d.createVolume({ Name: spec.name, Driver: 'local', DriverOpts: spec.options });
  }
  return { name: spec.name, mode: spec.mode, created: true };
}

export async function removeVolume(
  docker: DockerClient,
  p: RemoveVolumePayload,
): Promise<{ name: string; removed: boolean }> {
  await docker.docker.getVolume(p.name).remove({ force: true } as unknown as undefined).catch(() => undefined);
  return { name: p.name, removed: true };
}
