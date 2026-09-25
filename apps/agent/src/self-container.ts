/**
 * The container this agent runs in, found reliably.
 *
 * `getContainer(os.hostname())` only works on a bridge/overlay container, where
 * the hostname is the short container id. On the host network (node #1's agent
 * since QA-066 e) the hostname is the HOST's, so every self-lookup failed:
 * the nsenter host-exec (mesh pin, overlay heal, mesh front, registry
 * firewall) found no image to run. Found on the Lima repro. The id is also in
 * /proc/self/mountinfo: Docker bind-mounts /etc/hostname, /etc/hosts and
 * /etc/resolv.conf from /var/lib/docker/containers/<id>/, whatever the network
 * mode.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { DockerClient } from '@swarmy/core/docker';

/** Pure: the container id Docker's own bind mounts name in a mountinfo dump. */
export function containerIdFromMountinfo(mountinfo: string): string | undefined {
  return /\/containers\/([0-9a-f]{64})\//.exec(mountinfo)?.[1];
}

export interface SelfContainer {
  Id: string;
  Image?: string;
  HostConfig?: { NetworkMode?: string };
}

/** Inspect this agent's own container, or null (a binary agent, or no socket). */
export async function selfContainer(docker: DockerClient): Promise<SelfContainer | null> {
  const d = docker.docker;
  const candidates: string[] = [];
  try {
    const id = containerIdFromMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'));
    if (id) candidates.push(id);
  } catch {
    // not Linux / no procfs
  }
  candidates.push(os.hostname(), 'swarmy-agent');
  for (const c of candidates) {
    const i = (await d
      .getContainer(c)
      .inspect()
      .catch(() => null)) as SelfContainer | null;
    // The name fallback must really be us: a host-network agent shares the
    // host's hostname, and a binary agent must never adopt a container.
    if (i?.Id && (c !== 'swarmy-agent' || candidates[0] === i.Id)) return i;
  }
  return null;
}
