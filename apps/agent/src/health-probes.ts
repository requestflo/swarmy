/**
 * Docker's health record on the container snapshot (board AppRollout, "Last
 * probes"). `docker ps` only says healthy/unhealthy; the probe log lives in
 * container inspect `State.Health`, so the agent inspects the running
 * containers that HAVE a check — at most once per TTL each (or as soon as
 * their health word changes), at most MAX_PER_TICK per snapshot — and folds
 * the compact record into `ContainerInfo.health`. A read on the snapshot,
 * never a command; best-effort (an inspect that fails just leaves it out).
 */
import { psHealthWord } from '@swarmy/core';
import type { ContainerHealth, ContainerInfo } from '@swarmy/core/protocol';

export const HEALTH_TTL_MS = 10_000;
export const HEALTH_MAX_PER_TICK = 32;

interface Cached {
  at: number;
  health: ContainerHealth | undefined;
}

export type HealthReader = (containerId: string) => Promise<ContainerHealth | undefined>;

/** A per-agent prober with its own cache; returns the snapshot with `health` folded in. */
export function createHealthProber(read: HealthReader): (containers: ContainerInfo[], now?: number) => Promise<ContainerInfo[]> {
  const cache = new Map<string, Cached>();
  return async (containers, now = Date.now()) => {
    const present = new Set(containers.map((c) => c.id));
    for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
    const due = containers
      .filter((c) => {
        if (c.state !== 'running') return false;
        const word = psHealthWord(c.status);
        if (!word) return false;
        const hit = cache.get(c.id);
        return !hit || now - hit.at >= HEALTH_TTL_MS || hit.health?.status !== word;
      })
      .slice(0, HEALTH_MAX_PER_TICK);
    await Promise.all(
      due.map(async (c) => {
        const health = await read(c.id).catch(() => undefined);
        cache.set(c.id, { at: now, health });
      }),
    );
    return containers.map((c) => {
      const health = c.state === 'running' && psHealthWord(c.status) ? cache.get(c.id)?.health : undefined;
      return health ? { ...c, health } : c;
    });
  };
}
