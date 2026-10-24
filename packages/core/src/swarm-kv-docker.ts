/**
 * swarm-kv driver over a local Docker Engine API (dockerode). Used where a
 * process holds a manager's Docker socket itself — the integration test and
 * the agent-side rescue paths. The controller has no socket; it uses the
 * hub driver in `@swarmy/trpc` (`config.*` commands to a manager agent).
 *
 * Server-only (dockerode): import it as `@swarmy/core/swarm-kv-docker` (or a
 * relative path), never through the core barrel. The disaster-restore CLI uses
 * {@link localDockerKvDriver} to read where the backups are with the
 * controller down.
 */
import Docker from 'dockerode';
import { KV_LABEL, type KvConfigInfo, type KvDriver } from './swarm-kv';

interface RawConfig {
  ID?: string;
  CreatedAt?: string;
  Spec?: { Name?: string; Labels?: Record<string, string>; Data?: string };
}

export function dockerKvDriver(docker: Docker): KvDriver {
  const idOf = async (name: string): Promise<string> => {
    const all = (await docker.listConfigs({ filters: { name: [name] } })) as unknown as RawConfig[];
    return all.find((c) => c.Spec?.Name === name)?.ID ?? name;
  };
  return {
    async list(): Promise<KvConfigInfo[]> {
      const all = (await docker.listConfigs({
        filters: { label: [`${KV_LABEL}=1`] },
      })) as unknown as RawConfig[];
      return all.map((c) => ({
        name: c.Spec?.Name ?? '',
        createdAt: Date.parse(c.CreatedAt ?? '') || 0,
        labels: c.Spec?.Labels ?? {},
      }));
    },
    async read(name) {
      const raw = (await docker.getConfig(await idOf(name)).inspect()) as unknown as RawConfig;
      return raw.Spec?.Data ?? '';
    },
    async create(name, dataB64, labels) {
      await docker.createConfig({ Name: name, Data: dataB64, Labels: labels });
    },
    async remove(name) {
      await docker.getConfig(await idOf(name)).remove();
    },
  };
}

/** A driver over this host's Docker socket (DOCKER_HOST, else /var/run/docker.sock). Needs a swarm manager. */
export function localDockerKvDriver(opts?: Docker.DockerOptions): KvDriver {
  return dockerKvDriver(new Docker(opts));
}
