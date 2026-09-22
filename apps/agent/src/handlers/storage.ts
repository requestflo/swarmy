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
import type { ServiceSpec } from '@swarmy/core/protocol';
import { runOnce } from './swarmres';

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
  /** Swarm Docker config refs (replace the host-file bind mount; see the Zod schema). */
  configs?: { source: string; target: string; mode?: number }[];
  /** Swarm Docker SECRET refs (rpc secret / admin token; see the Zod schema). */
  secrets?: { source: string; target: string; mode?: number }[];
  placement?: { constraints: string[] };
  serviceMode?: 'replicated' | 'global';
  /** Overlay networks the store joins; present ⇒ NO published ports (see the Zod schema). */
  networks?: string[];
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

  // Config delivered as swarm Docker configs (controller-created) ⇒ no host
  // file and no bind mount: the task can land on any node, and a containerised
  // agent never writes into its own filesystem by mistake.
  const useConfigs = Boolean(r.configs?.length);
  // Overlay-only when the render names networks: the store is private, reached
  // by swarm DNS on the overlay, and publishes nothing on the routing mesh.
  const overlay = r.networks?.length ? r.networks : undefined;

  // Deploy/update the store member as a swarm service via the existing helpers.
  const spec: ServiceSpec = {
    name: r.serviceName,
    image: r.image,
    mode: r.serviceMode === 'global' ? { global: {} } : { replicated: { replicas: 1 } },
    // `r.labels` carries controller-side additions (e.g. the swarmy-system
    // stack namespace) layered over the agent's own base labels.
    labels: {
      'swarmy.managed': 'true',
      'swarmy.component': 'storage',
      'swarmy.driver': r.driver,
      ...r.labels,
    },
    // `[]` (not omitted) so an update also strips legacy published ports.
    ports: overlay
      ? []
      : [
          { target: r.s3Port, protocol: 'tcp' as const, mode: 'ingress' as const },
          ...(r.adminPort
            ? [{ target: r.adminPort, protocol: 'tcp' as const, mode: 'ingress' as const }]
            : []),
        ],
    ...(overlay ? { networks: overlay } : {}),
    mounts: [
      { type: 'volume' as const, source: `${r.serviceName}-meta`, target: '/var/lib/garage/meta' },
      { type: 'volume' as const, source: `${r.serviceName}-data`, target: '/var/lib/garage/data' },
      ...(!useConfigs && r.files.length
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
    ...(useConfigs ? { configs: r.configs } : {}),
    ...(r.secrets?.length ? { secrets: r.secrets } : {}),
    ...(r.placement ? { placement: { constraints: r.placement.constraints } } : {}),
  };

  let serviceId = '';
  const existing = await docker.getServiceByName(spec.name);
  if (!existing) {
    serviceId = await docker.createService(spec);
  } else {
    const inspect = await existing.inspect();
    serviceId = inspect.ID;
    const liveGlobal = Boolean((inspect.Spec as { Mode?: { Global?: unknown } } | undefined)?.Mode?.Global);
    const wantGlobal = r.serviceMode === 'global';
    if (useConfigs && liveGlobal !== wantGlobal) {
      // Swarm cannot change a service's mode in place: recreate it. The named
      // meta/data volumes are untouched, so a member keeps its data.
      await existing.remove();
      serviceId = await docker.createService(spec);
    } else if (useConfigs) {
      // Converge an existing member (e.g. a legacy host-bind spec, or a
      // rotated config) with a full spec update. Keep labels other writers
      // stamped (the storage-reconcile stats label), ours win on conflict.
      const liveLabels = (inspect.Spec as { Labels?: Record<string, string> } | undefined)?.Labels ?? {};
      const opts = (await docker.prepareServiceOptions({
        ...spec,
        labels: { ...liveLabels, ...spec.labels },
      })) as Record<string, unknown>;
      await existing.update({ version: inspect.Version.Index, ...opts });
    }
  }

  let layoutApplied = false;
  if (r.adminApi && overlay) {
    // The admin URL is an overlay name (`swarmy-garage:3903`): a systemd agent
    // process cannot resolve it, so run the call as a one-shot curl container
    // attached to the overlay. Token + body ride as container env only.
    layoutApplied = await adminCallOnOverlay(docker, p.commandId, overlay[0]!, r.adminApi).catch(
      () => false,
    );
  } else if (r.adminApi) {
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

/** Pinned curl image for overlay admin calls (mirrors the controller's CURL_IMAGE). */
export const ADMIN_CURL_IMAGE = 'curlimages/curl:8.10.1';
const ADMIN_STATUS_MARKER = '__SWARMY_STATUS__:';

/** One-shot admin call: `curl` on `network`; env-only secrets. True on HTTP 2xx. */
export async function adminCallOnOverlay(
  docker: DockerClient,
  commandId: string,
  network: string,
  call: NonNullable<RenderedStoreDeployment['adminApi']>,
): Promise<boolean> {
  const script = [
    'set -eu',
    'set -- -sS -o /dev/null -w "%{http_code}" -X "$ADMIN_METHOD"',
    'if [ -n "${ADMIN_TOKEN:-}" ]; then set -- "$@" -H "Authorization: Bearer $ADMIN_TOKEN"; fi',
    'if [ -n "${ADMIN_BODY:-}" ]; then set -- "$@" -H "Content-Type: $ADMIN_CONTENT_TYPE" --data-binary "$ADMIN_BODY"; fi',
    `echo "${ADMIN_STATUS_MARKER}$(curl "$@" "$ADMIN_URL")"`,
  ].join('\n');
  const res = await runOnce(docker, {
    commandId,
    image: ADMIN_CURL_IMAGE,
    entrypoint: ['/bin/sh', '-c'],
    cmd: [script],
    env: {
      ADMIN_METHOD: call.method,
      ADMIN_URL: call.url,
      ADMIN_CONTENT_TYPE: call.contentType ?? 'application/json',
      ...(call.bearerToken ? { ADMIN_TOKEN: call.bearerToken } : {}),
      ...(call.body ? { ADMIN_BODY: call.body } : {}),
    },
    networks: [network],
    pull: true,
    timeoutMs: 30_000,
  });
  const m = res.output.match(/__SWARMY_STATUS__:(\d{3})/);
  const code = m ? Number(m[1]) : 0;
  return code >= 200 && code < 300;
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
