/**
 * Swarm placement, read the way Swarm reads it — PURE, so a screen and the
 * controller can say where a task may (and will) run without asking Docker.
 *
 *   constraints  `node.id|hostname|role|platform.os|platform.arch|labels.<k>`
 *                with `==` / `!=`, matched case-insensitively (swarmkit's
 *                `EqualFold`). A missing node label never equals and always
 *                differs. Anything else (engine labels, node.ip) is unknown.
 *   scheduling   a new task of a service goes to the eligible server with the
 *                fewest tasks of that service, ties to the one with the fewest
 *                tasks overall (swarmkit's `nodeLess`), after each `spread=`
 *                preference has narrowed to its least-loaded group.
 */

export interface PlacementNode {
  swarmNodeId: string;
  hostname: string;
  role: string;
  os?: string;
  arch?: string;
  labels: Record<string, string>;
}

const RULE_RE = /^\s*([A-Za-z0-9_.\-]+)\s*(==|!=)\s*(.*?)\s*$/;

/** The node's value for a constraint/preference key; undefined = it has none; null = swarmy can't read it. */
export function placementValue(key: string, n: PlacementNode): string | undefined | null {
  if (key === 'node.id') return n.swarmNodeId;
  if (key === 'node.hostname') return n.hostname;
  if (key === 'node.role') return n.role;
  if (key === 'node.platform.os') return n.os ?? null;
  if (key === 'node.platform.arch') return n.arch ?? null;
  if (key.startsWith('node.labels.')) return n.labels[key.slice('node.labels.'.length)];
  return null;
}

/** Does `n` satisfy the constraint? null when swarmy can't tell. */
export function constraintHolds(rule: string, n: PlacementNode): boolean | null {
  const m = RULE_RE.exec(rule);
  if (!m) return null;
  const [, key, op, want] = m as unknown as [string, string, '==' | '!=', string];
  const have = placementValue(key, n);
  if (have === null) return null;
  const equal = have !== undefined && have.toLowerCase() === want.toLowerCase();
  return op === '==' ? equal : !equal;
}

/** A server as a place for one more task: its swarm view and what runs there now. */
export interface ScheduleCandidate {
  id: string;
  node: PlacementNode;
  /** Tasks of this service there. */
  copies: number;
  /** Swarm tasks of any service there (the tie-break); null = unknown. */
  tasks: number | null;
}

/**
 * Where Swarm would start ONE more task among `eligible`: narrowed by each
 * `spread=` preference, then fewest copies, then fewest tasks. Returns every
 * candidate it can't tell apart (more than one = a coin toss to swarmy).
 */
export function nextTaskGoesTo<C extends ScheduleCandidate>(eligible: readonly C[], preferences: readonly string[] = []): C[] {
  let pool = [...eligible];
  for (const p of preferences) {
    const key = p.startsWith('spread=') ? p.slice('spread='.length) : null;
    const value = (c: C) => (key ? placementValue(key, c.node) : null);
    if (!key || pool.some((c) => value(c) === null)) continue;
    const load = new Map<string, number>();
    for (const c of eligible) load.set(value(c) ?? '', (load.get(value(c) ?? '') ?? 0) + c.copies);
    const least = Math.min(...pool.map((c) => load.get(value(c) ?? '') ?? 0));
    pool = pool.filter((c) => (load.get(value(c) ?? '') ?? 0) === least);
  }
  const fewest = Math.min(...pool.map((c) => c.copies));
  pool = pool.filter((c) => c.copies === fewest);
  const known = pool.filter((c) => c.tasks !== null);
  if (known.length < pool.length) return pool;
  const idlest = Math.min(...known.map((c) => c.tasks!));
  return pool.filter((c) => c.tasks === idlest);
}
