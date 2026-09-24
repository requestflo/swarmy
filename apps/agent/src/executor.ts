import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { carryLogDriver, carryNetworkAliases, DockerClient, dropAliasesOnTargets, toServiceCreateOptions } from '@swarmy/core/docker';
import type { ControllerEnvelope, RegistryAuth, RenderedConfig, ServiceSpec } from '@swarmy/core/protocol';
import type { AgentConnection } from './connection';
import { buildGateAllows, BUILDER_ENABLE_HINT, execGateAllows, EXEC_LOCAL_VETO_HINT, EXEC_ENABLE_HINT } from '@swarmy/core';
import { env } from './env';
import { backupVolume, restoreVolume, listSnapshots, backupDb, restoreDb } from './handlers/backup';
import { appDbBackup, appDbRestore, appDbVerify } from './handlers/appdb';
import { queueOp } from './handlers/queue-op';
import { dbQuery } from './handlers/studio';
import { execCommand } from './handlers/exec';
import { applyDns } from './handlers/dns';
import { localReload } from './handlers/ingress-local';
import { applyMesh } from './handlers/mesh';
import { applyMeshControl } from './handlers/mesh-control';
import { applyAccessRouter } from './handlers/access-router';
import { applyIngressConnector } from './handlers/ingress-connector';
import { buildImage } from './handlers/build';
import { pruneImages } from './handlers/prune';
import { runNodeHygiene } from './handlers/hygiene';
import { applyStorageNode, listVolumes, provisionVolume, removeVolume } from './handlers/storage';
import { applySwarmJoin, rotateSwarmTokens, setSwarmAutolock } from './handlers/swarm';
import { applyControllerService } from './handlers/controller-service';
import { probeSmtp } from './handlers/email';
import { updateAgent } from './handlers/update';
import { prepareSecretEnv } from './handlers/secret-env';
import {
  secretCreate,
  secretRemove,
  secretList,
  configCreate,
  configRemove,
  configList,
  configInspect,
  runOnce,
} from './handlers/swarmres';
import { pushInventory } from './snapshots';
import {
  handleTermStart,
  handleTermInput,
  handleTermResize,
  handleTermClose,
} from './handlers/terminal';

const activeLogStreams = new Map<string, () => void>();

/** E_BUILD_DISABLED message: says WHY (local veto vs role off) and how to enable. */
export function buildDisabledMessage(what: string, override = env.BUILD_OVERRIDE): string {
  if (override === 'deny') {
    return `${what} disabled on this agent: SWARMY_ALLOW_BUILD=false is set locally (remove it from /etc/swarmy/agent.env to let the Builder role decide)`;
  }
  return `${what} disabled on this agent: this node does not have the Builder role — ${BUILDER_ENABLE_HINT}`;
}

/**
 * SWARMY_ALLOW_EXEC=false is a node-local promise that nothing execs into a
 * container here. The studio, queue and app-DB commands all exec into a task
 * (or its DB client), so they honour the same local veto as `execCommand`.
 * Returns true (and answers the command) when vetoed.
 */
function execVetoed(conn: AgentConnection, commandId: string): boolean {
  if (env.EXEC_OVERRIDE !== 'deny') return false;
  conn.send('commandResult', {
    commandId,
    status: 'rejected',
    error: { code: 'E_EXEC_DISABLED', message: `exec is ${EXEC_LOCAL_VETO_HINT}` },
  });
  return true;
}

export async function handleCommand(
  docker: DockerClient,
  conn: AgentConnection,
  envlp: ControllerEnvelope,
): Promise<void> {
  switch (envlp.type) {
    case 'ping':
      conn.send('ack', { refId: envlp.id, accepted: true });
      return;
    case 'deployService': {
      const { commandId, spec, registryAuth, pullPolicy } = envlp.payload;
      await run(conn, commandId, () =>
        deployOrUpdate(docker, spec, registryAuth ?? spec.registryAuth, { pullPolicy }),
      );
      pushInventory(docker, conn);
      return;
    }
    case 'scaleService': {
      const { commandId, service, replicas } = envlp.payload;
      await run(conn, commandId, async () => ({ serviceId: await docker.scaleService(service, replicas) }));
      pushInventory(docker, conn);
      return;
    }
    case 'restartService': {
      const { commandId, service } = envlp.payload;
      await run(conn, commandId, async () => ({ serviceId: await docker.restartService(service) }));
      pushInventory(docker, conn);
      return;
    }
    case 'inspectService': {
      const { commandId, service } = envlp.payload;
      // Read-only: surface the full raw inspect; no inventory push needed.
      await run(conn, commandId, async () => ({ inspect: await docker.inspectService(service) }));
      return;
    }
    case 'removeService': {
      const { commandId, service } = envlp.payload;
      await run(conn, commandId, async () => {
        await docker.removeService(service);
        return { serviceId: service };
      });
      pushInventory(docker, conn);
      return;
    }
    case 'updateServiceLabels': {
      const { commandId, service, add, removeKeys } = envlp.payload;
      await run(conn, commandId, async () => ({
        serviceId: await docker.updateServiceLabels(service, add, removeKeys),
      }));
      pushInventory(docker, conn);
      return;
    }
    case 'pullImage': {
      const { commandId, image, registryAuth } = envlp.payload;
      return run(conn, commandId, async () => {
        const digest = await docker.pullImage(
          image,
          registryAuth
            ? { username: registryAuth.username, password: registryAuth.password, serveraddress: registryAuth.server }
            : undefined,
        );
        return { image, digest };
      });
    }
    case 'updateSwarmNode': {
      const { commandId, swarmNodeId, availability, labels, role, remove } = envlp.payload;
      return run(conn, commandId, async () => {
        if (remove) {
          await docker.removeSwarmNode(swarmNodeId);
          return { swarmNodeId, removed: true };
        }
        await docker.updateSwarmNode(swarmNodeId, { availability, labels, role });
        return { swarmNodeId };
      });
    }
    case 'applyIngress': {
      const { commandId, rendered } = envlp.payload;
      return run(conn, commandId, () => applyIngress(docker, rendered));
    }
    case 'applyDns': {
      const { commandId } = envlp.payload;
      return run(conn, commandId, () => applyDns(envlp.payload));
    }
    case 'applyMesh': {
      const { commandId, rendered } = envlp.payload;
      if (!env.ALLOW_MESH) {
        conn.send('commandResult', {
          commandId,
          status: 'rejected',
          error: { code: 'E_MESH_DISABLED', message: 'mesh disabled on this agent' },
        });
        return;
      }
      return run(conn, commandId, () => applyMesh(docker, rendered));
    }
    case 'applyMeshControl':
    case 'applyAccessRouter': {
      const p = envlp.payload;
      if (!env.ALLOW_MESH) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_MESH_DISABLED', message: 'mesh disabled on this agent' },
        });
        return;
      }
      return envlp.type === 'applyMeshControl'
        ? run(conn, p.commandId, () => applyMeshControl(docker, envlp.payload))
        : run(conn, p.commandId, () => applyAccessRouter(docker, envlp.payload));
    }
    case 'backupVolume': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => backupVolume(docker, conn, p));
    }
    case 'restoreVolume': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => restoreVolume(docker, conn, p));
    }
    case 'listSnapshots': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => listSnapshots(docker, p));
    }
    case 'ensureNetwork': {
      const p = envlp.payload;
      return run(conn, p.commandId, async () => ({
        networkId: await docker.ensureNetwork(p.name, {
          driver: p.driver,
          attachable: p.attachable,
          labels: p.labels,
          options: p.options,
        }),
      }));
    }
    case 'removeStackNetworks': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => docker.removeStackNetworks(p.stack));
    }
    case 'dbBackup': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => backupDb(docker, conn, p));
    }
    case 'dbRestore': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => restoreDb(docker, conn, p));
    }
    case 'appDbBackup': {
      const p = envlp.payload;
      if (execVetoed(conn, p.commandId)) return;
      return run(conn, p.commandId, () => appDbBackup(docker, conn, p));
    }
    case 'appDbRestore': {
      const p = envlp.payload;
      if (execVetoed(conn, p.commandId)) return;
      return run(conn, p.commandId, () => appDbRestore(docker, conn, p));
    }
    case 'appDbVerify': {
      const p = envlp.payload;
      if (execVetoed(conn, p.commandId)) return;
      return run(conn, p.commandId, () => appDbVerify(docker, conn, p));
    }
    case 'queueOp': {
      // Bounded BullMQ EVAL; the handler enforces DEFAULT_COMMAND_TIMEOUTS.queueOp.
      const p = envlp.payload;
      if (execVetoed(conn, p.commandId)) return;
      return run(conn, p.commandId, () => queueOp(docker, p));
    }
    case 'dbQuery': {
      // Database studio: one bounded query via the DB task's own client (in-task creds).
      const p = envlp.payload;
      if (execVetoed(conn, p.commandId)) return;
      return run(conn, p.commandId, () => dbQuery(docker, p));
    }
    case 'buildImage': {
      const p = envlp.payload;
      if (!buildGateAllows(env.BUILD_OVERRIDE, p.builderCapable)) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_BUILD_DISABLED', message: buildDisabledMessage('build') },
        });
        return;
      }
      return run(conn, p.commandId, () => buildImage(docker, conn, p));
    }
    case 'pruneImages': {
      const p = envlp.payload;
      // Dangling-only cleanup is safe housekeeping on any node; the build gate
      // only guards pruning swarmy's own build images.
      if (p.strategy !== 'dangling' && !buildGateAllows(env.BUILD_OVERRIDE, p.builderCapable)) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_BUILD_DISABLED', message: buildDisabledMessage('image GC') },
        });
        return;
      }
      return run(conn, p.commandId, () => pruneImages(docker, p));
    }
    case 'nodeHygiene': {
      const p = envlp.payload;
      if (!env.ALLOW_HYGIENE) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_HYGIENE_DISABLED', message: 'disk hygiene is disabled on this node (SWARMY_ALLOW_HYGIENE=false)' },
        });
        return;
      }
      return run(conn, p.commandId, async () => {
        const result = await runNodeHygiene(docker, p);
        if (!p.dryRun && result.containers.removed > 0) pushInventory(docker, conn);
        return result;
      });
    }
    case 'applyStorageNode': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => applyStorageNode(docker, p));
    }
    case 'provisionVolume': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => provisionVolume(docker, p));
    }
    case 'removeVolume': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => removeVolume(docker, p));
    }
    case 'listVolumes': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => listVolumes(docker, p));
    }
    case 'swarmJoin': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => applySwarmJoin(docker, p));
    }
    case 'swarmSetAutolock': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => setSwarmAutolock(docker, p));
    }
    case 'swarmRotateTokens': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => rotateSwarmTokens(docker, p));
    }
    case 'probeSmtp': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => probeSmtp(p));
    }
    case 'controllerService': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => applyControllerService(docker, p));
    }
    case 'updateAgent': {
      // On success the handler schedules its own exit AFTER the result has had
      // time to flush; systemd (Restart=always) or the replacement container
      // brings the new version up, and its register confirms the new version.
      const p = envlp.payload;
      return run(conn, p.commandId, () => updateAgent(docker, p));
    }
    case 'secretCreate': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => secretCreate(docker, p));
    }
    case 'secretRemove': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => secretRemove(docker, p));
    }
    case 'secretList': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => secretList(docker));
    }
    case 'configCreate': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => configCreate(docker, p));
    }
    case 'configRemove': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => configRemove(docker, p));
    }
    case 'configList': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => configList(docker));
    }
    case 'configInspect': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => configInspect(docker, p));
    }
    case 'runOnce': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => runOnce(docker, p));
    }
    case 'streamLogs':
      return handleStreamLogs(docker, conn, envlp.payload);
    case 'termStart':
      return handleTermStart(docker, conn, envlp.payload);
    case 'termInput':
      handleTermInput(envlp.payload);
      return;
    case 'termResize':
      handleTermResize(envlp.payload);
      return;
    case 'termClose':
      handleTermClose(envlp.payload);
      return;
    case 'execCommand': {
      const { commandId } = envlp.payload;
      if (!execGateAllows(env.EXEC_OVERRIDE, envlp.payload.nodeCapable)) {
        conn.send('commandResult', {
          commandId,
          status: 'rejected',
          error: {
            code: 'E_EXEC_DISABLED',
            message: env.EXEC_OVERRIDE === 'deny' ? `exec is ${EXEC_LOCAL_VETO_HINT}` : `exec is off for this node — ${EXEC_ENABLE_HINT}`,
          },
        });
        return;
      }
      return run(conn, commandId, () => execCommand(docker, conn, envlp.payload));
    }
    default:
      return;
  }
}

async function run(
  conn: AgentConnection,
  commandId: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  conn.send('commandResult', { commandId, status: 'running', startedAt: Date.now() });
  try {
    const result = await fn();
    conn.send('commandResult', { commandId, status: 'succeeded', finishedAt: Date.now(), result });
  } catch (e) {
    // Never fail silently: a failed command must reach journalctl too, not
    // only the controller (a stale-manager swarm join vanished this way).
    console.error(`[agent] command ${commandId} failed: ${e instanceof Error ? e.message : String(e)}`);
    conn.send('commandResult', {
      commandId,
      status: 'failed',
      finishedAt: Date.now(),
      error: { code: 'E_DOCKER', message: e instanceof Error ? e.message : String(e) },
    });
  }
}

export async function deployOrUpdate(
  docker: DockerClient,
  input: ServiceSpec,
  registryAuth?: RegistryAuth,
  deployOpts: { pullPolicy?: 'always' | 'missing' | 'never' } = {},
): Promise<{ serviceId: string; created: boolean }> {
  // Pull creds ride the X-Registry-Auth header (never the spec body) so the swarm
  // stores them with the service and every node can pull a private image.
  const auth = registryAuth
    ? { username: registryAuth.username, password: registryAuth.password, serveraddress: registryAuth.server }
    : undefined;
  // Secret app variables delivered as env: wrap the container in the
  // secret-env shim (values stay in /run/secrets — see handlers/secret-env).
  const spec = await prepareSecretEnv(docker, input, {
    pull: deployOpts.pullPolicy === 'always',
    authconfig: auth,
  });
  const existing = await docker.getServiceByName(spec.name);
  if (!existing) {
    const id = await docker.createService(spec, auth);
    return { serviceId: id, created: true };
  }
  const inspect = await existing.inspect();
  const opts = (await docker.prepareServiceOptions(spec)) as Record<string, unknown>;
  // Keep in-stack DNS aliases across lossy rebuilds (see carryNetworkAliases).
  carryNetworkAliases(
    opts as Parameters<typeof carryNetworkAliases>[0],
    spec,
    (inspect.Spec?.TaskTemplate as { Networks?: Array<{ Target?: string; Aliases?: string[] }> } | undefined)
      ?.Networks,
  );
  // Keep an operator-set log driver across lossy rebuilds; a service with none
  // picks up swarmy's bounded json-file default (see DEFAULT_LOG_DRIVER).
  carryLogDriver(
    opts as Parameters<typeof carryLogDriver>[0],
    spec,
    (inspect.Spec?.TaskTemplate as { LogDriver?: { Name?: string; Options?: Record<string, string> } } | undefined)
      ?.LogDriver,
  );
  // …but never onto the platform overlays: a legacy alias there is dropped.
  dropAliasesOnTargets(
    opts as Parameters<typeof dropAliasesOnTargets>[0],
    (await docker.platformNetworkIds?.()) ?? new Set<string>(),
  );
  await docker.updateServiceWithAuth(existing, { version: inspect.Version.Index, ...opts }, auth);
  return { serviceId: inspect.ID, created: false };
}

async function execShell(cmd: string[]): Promise<void> {
  if (!cmd.length) return;
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}`);
}

async function applyIngress(
  docker: DockerClient,
  rendered: RenderedConfig,
): Promise<{ driver: string; reloaded: boolean }> {
  for (const file of rendered.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { mode: file.mode ?? 0o644 });
  }
  for (const sl of rendered.serviceLabels) {
    try {
      const svc = await docker.getServiceByName(sl.service);
      if (!svc) continue;
      const inspect = await svc.inspect();
      const spec = inspect.Spec as { Labels?: Record<string, string> };
      spec.Labels = { ...(spec.Labels ?? {}), ...sl.labels };
      for (const key of sl.removeLabelKeys) delete spec.Labels[key];
      await svc.update({ version: inspect.Version.Index, ...(spec as Record<string, unknown>) });
    } catch {
      // best-effort label sync
    }
  }
  // Edge-per-node: reload THIS node's task of the edge service (geo-edge).
  if (rendered.localReload) {
    await localReload(
      docker,
      rendered.localReload.service,
      rendered.localReload.command,
      rendered.localReload.file,
    );
  }
  if (rendered.reloadCommand?.length) await execShell(rendered.reloadCommand);
  if (rendered.adminApi) {
    // A failed admin push means the routes did NOT land — surface it (the
    // controller records it and the dashboard shows the edge as degraded)
    // instead of reporting a successful apply over a dead proxy.
    const res = await fetch(rendered.adminApi.url, {
      method: rendered.adminApi.method,
      body: rendered.adminApi.body,
      headers: rendered.adminApi.contentType ? { 'content-type': rendered.adminApi.contentType } : undefined,
    }).catch((e: unknown) => {
      throw new Error(
        `ingress admin API ${rendered.adminApi?.url} unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ingress admin API ${rendered.adminApi.url} returned ${res.status}: ${body.slice(0, 400)}`);
    }
  }
  // Token-mode tunnels (e.g. cloudflared) deploy a connector swarm service.
  await applyIngressConnector(docker, rendered);
  return { driver: rendered.driver, reloaded: true };
}

async function handleStreamLogs(
  docker: DockerClient,
  conn: AgentConnection,
  p: Extract<ControllerEnvelope, { type: 'streamLogs' }>['payload'],
): Promise<void> {
  if (p.action === 'stop') {
    activeLogStreams.get(p.commandId)?.();
    activeLogStreams.delete(p.commandId);
    conn.send('commandResult', { commandId: p.commandId, status: 'canceled' });
    return;
  }
  try {
    const logOpts = {
      follow: true as const,
      stdout: true,
      stderr: true,
      tail: p.tail,
      timestamps: p.timestamps,
    };
    let stream: NodeJS.ReadableStream;
    if (p.target.kind === 'container') {
      stream = (await docker.docker.getContainer(p.target.containerId).logs(logOpts)) as unknown as NodeJS.ReadableStream;
    } else {
      const svc = await docker.getServiceByName(p.target.service);
      if (!svc) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'failed',
          error: { code: 'E_NOT_MANAGER', message: 'service logs require a manager' },
        });
        return;
      }
      stream = (await svc.logs(logOpts)) as unknown as NodeJS.ReadableStream;
    }
    let seq = 0;
    stream.on('data', (chunk: Buffer) => {
      conn.send('logChunk', {
        commandId: p.commandId,
        stream: 'stdout',
        seq: seq++,
        data: chunk.toString('utf8'),
        eof: false,
      });
    });
    stream.on('end', () => {
      conn.send('logChunk', { commandId: p.commandId, stream: 'stdout', seq: seq++, data: '', eof: true });
    });
    activeLogStreams.set(p.commandId, () => (stream as unknown as { destroy?: () => void }).destroy?.());
  } catch (e) {
    conn.send('commandResult', {
      commandId: p.commandId,
      status: 'failed',
      error: { code: 'E_DOCKER', message: e instanceof Error ? e.message : String(e) },
    });
  }
}
