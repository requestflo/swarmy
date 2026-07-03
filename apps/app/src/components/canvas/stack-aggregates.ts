import type { Inventory, InvService, InvServiceStatus } from '@swarmy/core';
import { SYSTEM_STACK_LABEL, UNGROUPED, isSystemStack } from '@swarmy/core';

/** Task-defined mapping: stopped reads as offline; idle is intentional, not an error. */
export const STATUS_TONE: Record<InvServiceStatus, string> = {
  running: 'online',
  degraded: 'warning',
  deploying: 'progress',
  stopped: 'offline',
  idle: 'idle',
};

/** Worst-of for a stack dot; idle is lowest because it's a chosen, healthy state. */
export function aggregateTone(services: InvService[]): string {
  const tones = new Set(services.map((s) => STATUS_TONE[s.status]));
  for (const t of ['offline', 'warning', 'progress', 'online']) if (tones.has(t)) return t;
  return 'idle';
}

export interface StackStat {
  /** Stack (Docker project) name; UNGROUPED for the catch-all. */
  name: string;
  /** Display label ("Ungrouped" for the catch-all). */
  label: string;
  ungrouped: boolean;
  /** True for swarmy's own platform stack (observability, ingress, Garage, mesh). */
  system: boolean;
  services: InvService[];
  serviceCount: number;
  /** Aggregate (worst-of) status token for the stack. */
  tone: string;
  /** Summed running / desired replicas (live containers) across the stack. */
  running: number;
  desired: number;
  /** Inferred links whose *both* endpoints live inside this stack. */
  linkCount: number;
}

/**
 * Pure: fold the live inventory into one StackStat per project — the data the
 * stack-overview cards render. Stack order follows `inventory.projects`
 * (ungrouped last, set upstream). Aggregate status is worst-of; replica totals
 * sum the live containers; link count is intra-stack edges only (a cross-stack
 * link belongs to neither card).
 */
export function computeStackStats(inv: Inventory): StackStat[] {
  const svcById = new Map(inv.services.map((s) => [s.id, s]));
  // The stacks home shows only real Docker stacks running in the swarm. Standalone
  // (ungrouped) containers aren't apps/stacks — they're viewed per-node under Nodes.
  const stats = inv.projects
    .filter((project) => project.name !== UNGROUPED)
    .map((project) => {
    const ids = new Set(project.serviceIds);
    const services = project.serviceIds
      .map((id) => svcById.get(id))
      .filter((s): s is InvService => Boolean(s));
    let running = 0;
    let desired = 0;
    for (const s of services) {
      running += s.replicas.running;
      desired += s.replicas.desired;
    }
    const linkCount = inv.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).length;
    const ungrouped = project.name === UNGROUPED;
    const system =
      isSystemStack(project.name) || services.some((s) => s.labels[SYSTEM_STACK_LABEL] === 'true');
    return {
      name: project.name,
      label: ungrouped ? 'Ungrouped' : project.name,
      ungrouped,
      system,
      services,
      serviceCount: services.length,
      tone: aggregateTone(services),
      running,
      desired,
      linkCount,
    };
  });
  // App stacks first (alpha, from inv.projects order), swarmy's own platform
  // stack sorts last — it's plumbing, not something you deployed.
  return stats.sort((a, b) => (a.system === b.system ? 0 : a.system ? 1 : -1));
}
