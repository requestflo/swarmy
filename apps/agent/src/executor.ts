import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DockerClient, toServiceCreateOptions } from '@swarmy/core/docker';
import type { ControllerEnvelope, RenderedConfig, ServiceSpec } from '@swarmy/core/protocol';
import type { AgentConnection } from './connection';
import { env } from './env';
import { backupVolume, restoreVolume, listSnapshots } from './handlers/backup';
import { applyMesh, grantDirectRoute } from './handlers/mesh';
import { applyIngressConnector } from './handlers/ingress-connector';
import { buildImage } from './handlers/build';
import { pruneImages } from './handlers/prune';
import { applyStorageNode, provisionVolume, removeVolume } from './handlers/storage';
import { applySwarmJoin } from './handlers/swarm';
import {
  handleTermStart,
  handleTermInput,
  handleTermResize,
  handleTermClose,
} from './handlers/terminal';

const activeLogStreams = new Map<string, () => void>();

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
      const { commandId, spec } = envlp.payload;
      return run(conn, commandId, () => deployOrUpdate(docker, spec));
    }
    case 'scaleService': {
      const { commandId, service, replicas } = envlp.payload;
      return run(conn, commandId, async () => ({ serviceId: await docker.scaleService(service, replicas) }));
    }
    case 'restartService': {
      const { commandId, service } = envlp.payload;
      return run(conn, commandId, async () => ({ serviceId: await docker.restartService(service) }));
    }
    case 'removeService': {
      const { commandId, service } = envlp.payload;
      return run(conn, commandId, async () => {
        await docker.removeService(service);
        return { serviceId: service };
      });
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
      const { commandId, swarmNodeId, availability, labels } = envlp.payload;
      return run(conn, commandId, async () => {
        await docker.updateSwarmNode(swarmNodeId, { availability, labels });
        return { swarmNodeId };
      });
    }
    case 'applyIngress': {
      const { commandId, rendered } = envlp.payload;
      return run(conn, commandId, () => applyIngress(docker, rendered));
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
    case 'grantDirectRoute': {
      const p = envlp.payload;
      if (!env.ALLOW_MESH) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_MESH_DISABLED', message: 'mesh disabled on this agent' },
        });
        return;
      }
      return run(conn, p.commandId, () => grantDirectRoute(p));
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
    case 'buildImage': {
      const p = envlp.payload;
      if (!env.ALLOW_BUILD) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_BUILD_DISABLED', message: 'build disabled on this agent' },
        });
        return;
      }
      return run(conn, p.commandId, () => buildImage(docker, conn, p));
    }
    case 'pruneImages': {
      const p = envlp.payload;
      if (!env.ALLOW_BUILD) {
        conn.send('commandResult', {
          commandId: p.commandId,
          status: 'rejected',
          error: { code: 'E_BUILD_DISABLED', message: 'image GC disabled on this agent' },
        });
        return;
      }
      return run(conn, p.commandId, () => pruneImages(docker, p));
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
    case 'swarmJoin': {
      const p = envlp.payload;
      return run(conn, p.commandId, () => applySwarmJoin(docker, p));
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
      if (!env.ALLOW_EXEC) {
        conn.send('commandResult', {
          commandId,
          status: 'rejected',
          error: { code: 'E_EXEC_DISABLED', message: 'exec disabled on this agent' },
        });
        return;
      }
      conn.send('commandResult', {
        commandId,
        status: 'rejected',
        error: { code: 'E_EXEC_DISABLED', message: 'exec not implemented' },
      });
      return;
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
    conn.send('commandResult', {
      commandId,
      status: 'failed',
      finishedAt: Date.now(),
      error: { code: 'E_DOCKER', message: e instanceof Error ? e.message : String(e) },
    });
  }
}

async function deployOrUpdate(
  docker: DockerClient,
  spec: ServiceSpec,
): Promise<{ serviceId: string; created: boolean }> {
  const existing = await docker.getServiceByName(spec.name);
  if (!existing) {
    const id = await docker.createService(spec);
    return { serviceId: id, created: true };
  }
  const inspect = await existing.inspect();
  const opts = toServiceCreateOptions(spec) as Record<string, unknown>;
  await existing.update({ version: inspect.Version.Index, ...opts });
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
  if (rendered.reloadCommand?.length) await execShell(rendered.reloadCommand);
  if (rendered.adminApi) {
    await fetch(rendered.adminApi.url, {
      method: rendered.adminApi.method,
      body: rendered.adminApi.body,
      headers: rendered.adminApi.contentType ? { 'content-type': rendered.adminApi.contentType } : undefined,
    }).catch(() => undefined);
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
