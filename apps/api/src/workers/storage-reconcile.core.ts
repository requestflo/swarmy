import { createHash } from 'node:crypto';

/**
 * Pure helpers for the storage-reconcile worker (WS5 — Garage lifecycle):
 * Garage admin-API response parsing (status/layout/health), garage-node →
 * swarmy-node matching, two-step layout planning (stage + apply), the
 * change-gated stats stamp, and failure backoff.
 *
 * Colocated `.core` module (the manageddb-reconcile.core pattern) so the unit
 * tests exercise the convergence logic without evaluating the worker's
 * gateway/trpc import graph. No network, no DB, no Docker — deterministic.
 *
 * Constants mirror `@swarmy/trpc` buckets.service.ts / replicatedStore.service.ts
 * / garage-render.ts (the unit-tested canonical copies) — a worker cannot
 * subpath-import an internal trpc module.
 */

// ── Mirrored constants ────────────────────────────────────────────────────────
export const STORE_SERVICE_NAME = 'swarmy-garage';
export const CURL_IMAGE = 'curlimages/curl:8.10.1';
export const GARAGE_ADMIN_PORT = 3903;
export const STATUS_MARKER = '__SWARMY_STATUS__:';
export const STORAGE_STATS_LABEL = 'swarmy.storage.stats';
export const DEFAULT_CAPACITY_GB = 100;

/** Admin API base as seen from a host-networked container on a swarm node. */
export function garageAdminBase(): string {
  return `http://127.0.0.1:${GARAGE_ADMIN_PORT}/v1`;
}

/** One-shot curl script — mirror of buckets.service.ts `buildAdminScript`. */
export function buildAdminScript(): string {
  return [
    'set -eu',
    'H="Authorization: Bearer $GARAGE_ADMIN_TOKEN"',
    'if [ -n "${GARAGE_BODY:-}" ]; then',
    '  code=$(curl -sS -o /tmp/swarmy.out -w \'%{http_code}\' -X "$GARAGE_METHOD" -H "$H" -H "Content-Type: application/json" --data-binary "$GARAGE_BODY" "$GARAGE_URL")',
    'else',
    '  code=$(curl -sS -o /tmp/swarmy.out -w \'%{http_code}\' -X "$GARAGE_METHOD" -H "$H" "$GARAGE_URL")',
    'fi',
    `echo "${STATUS_MARKER}$code"`,
    'cat /tmp/swarmy.out',
  ].join('\n');
}

export interface AdminResponse {
  status: number;
  body: string;
}

/** Parse `buildAdminScript` output → { status, body } (mirror). */
export function parseAdminOutput(output: string): AdminResponse {
  const idx = output.indexOf(STATUS_MARKER);
  if (idx < 0) return { status: 0, body: output.trim() };
  const rest = output.slice(idx + STATUS_MARKER.length);
  const nl = rest.indexOf('\n');
  const code = Number.parseInt((nl >= 0 ? rest.slice(0, nl) : rest).trim(), 10);
  return {
    status: Number.isNaN(code) ? 0 : code,
    body: nl >= 0 ? rest.slice(nl + 1).trim() : '',
  };
}

// ── Garage admin API response normalization (defensive) ──────────────────────

export interface GarageNodeStatus {
  id: string;
  /** Container hostname — Docker's default is the short (12-char) container id. */
  hostname: string | null;
  isUp: boolean;
  draining: boolean;
  role: { zone: string; capacity: number | null } | null;
  dataAvailableBytes: number | null;
  dataTotalBytes: number | null;
}

export interface GarageStatus {
  /** The answering node's own Garage node id. */
  node: string | null;
  layoutVersion: number | null;
  nodes: GarageNodeStatus[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize `GET /v1/status`. */
export function parseGarageStatus(raw: unknown): GarageStatus {
  const r = (raw ?? {}) as {
    node?: unknown;
    layoutVersion?: unknown;
    nodes?: unknown;
  };
  const nodes: GarageNodeStatus[] = [];
  for (const n of Array.isArray(r.nodes) ? r.nodes : []) {
    if (!n || typeof n !== 'object') continue;
    const v = n as {
      id?: unknown;
      hostname?: unknown;
      isUp?: unknown;
      draining?: unknown;
      role?: unknown;
      dataPartition?: unknown;
    };
    if (typeof v.id !== 'string' || !v.id) continue;
    const role =
      v.role && typeof v.role === 'object'
        ? (v.role as { zone?: unknown; capacity?: unknown })
        : null;
    const data =
      v.dataPartition && typeof v.dataPartition === 'object'
        ? (v.dataPartition as { available?: unknown; total?: unknown })
        : null;
    nodes.push({
      id: v.id,
      hostname: typeof v.hostname === 'string' && v.hostname ? v.hostname : null,
      isUp: Boolean(v.isUp),
      draining: Boolean(v.draining),
      role:
        role && typeof role.zone === 'string'
          ? { zone: role.zone, capacity: num(role.capacity) }
          : null,
      dataAvailableBytes: num(data?.available),
      dataTotalBytes: num(data?.total),
    });
  }
  return {
    node: typeof r.node === 'string' && r.node ? r.node : null,
    layoutVersion: num(r.layoutVersion),
    nodes,
  };
}

export interface GarageLayoutRole {
  id: string;
  zone: string;
  capacity: number | null;
}

export type GarageLayoutChange =
  | { id: string; remove: true }
  | { id: string; zone: string; capacity: number; tags: string[] };

export interface GarageLayout {
  version: number;
  roles: GarageLayoutRole[];
  staged: GarageLayoutChange[];
}

/** Normalize `GET /v1/layout`; null when the payload is unusable. */
export function parseGarageLayout(raw: unknown): GarageLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { version?: unknown; roles?: unknown; stagedRoleChanges?: unknown };
  const version = num(r.version);
  if (version === null) return null;
  const roles: GarageLayoutRole[] = [];
  for (const role of Array.isArray(r.roles) ? r.roles : []) {
    if (!role || typeof role !== 'object') continue;
    const v = role as { id?: unknown; zone?: unknown; capacity?: unknown };
    if (typeof v.id !== 'string' || typeof v.zone !== 'string') continue;
    roles.push({ id: v.id, zone: v.zone, capacity: num(v.capacity) });
  }
  const staged: GarageLayoutChange[] = [];
  for (const ch of Array.isArray(r.stagedRoleChanges) ? r.stagedRoleChanges : []) {
    if (!ch || typeof ch !== 'object') continue;
    const v = ch as {
      id?: unknown;
      remove?: unknown;
      zone?: unknown;
      capacity?: unknown;
      tags?: unknown;
    };
    if (typeof v.id !== 'string') continue;
    if (v.remove === true) {
      staged.push({ id: v.id, remove: true });
    } else if (typeof v.zone === 'string' && typeof v.capacity === 'number') {
      staged.push({
        id: v.id,
        zone: v.zone,
        capacity: v.capacity,
        tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [],
      });
    }
  }
  return { version, roles, staged };
}

export interface GarageHealth {
  status: string;
  knownNodes: number;
  connectedNodes: number;
  storageNodes: number;
  storageNodesOk: number;
  partitions: number;
  partitionsQuorum: number;
  partitionsAllOk: number;
}

/** Normalize `GET /v1/health`; null when the payload is unusable. */
export function parseGarageHealth(raw: unknown): GarageHealth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'string') return null;
  const n = (k: string): number => num(r[k]) ?? 0;
  return {
    status: r.status,
    knownNodes: n('knownNodes'),
    connectedNodes: n('connectedNodes'),
    storageNodes: n('storageNodes'),
    storageNodesOk: n('storageNodesOk'),
    partitions: n('partitions'),
    partitionsQuorum: n('partitionsQuorum'),
    partitionsAllOk: n('partitionsAllOk'),
  };
}

// ── garage node ↔ swarmy node matching ────────────────────────────────────────

/** Zone name a member is assigned in the layout — mirror of garage-render. */
export function zoneFor(swarmyNodeId: string): string {
  return `node-${swarmyNodeId}`;
}

/**
 * Map swarmy node ids to Garage node ids, most-authoritative source first:
 *  1. already-recorded mappings whose Garage node still exists,
 *  2. the layout zone (`node-<swarmyNodeId>` — assigned members),
 *  3. hostname = the short container id of the store task on that node,
 *  4. the unambiguous singleton (one unmatched garage node, one candidate node).
 */
export function matchGarageNodes(
  garageNodes: GarageNodeStatus[],
  containerHosts: Array<{ nodeId: string; containerIdShort: string }>,
  known: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  const claim = (nodeId: string, garageId: string): void => {
    if (nodeId in out || used.has(garageId)) return;
    out[nodeId] = garageId;
    used.add(garageId);
  };

  const ids = new Set(garageNodes.map((g) => g.id));
  for (const [nodeId, garageId] of Object.entries(known)) {
    if (ids.has(garageId)) claim(nodeId, garageId);
  }
  for (const g of garageNodes) {
    if (g.role && g.role.zone.startsWith('node-')) claim(g.role.zone.slice('node-'.length), g.id);
  }
  const byHostname = new Map(
    garageNodes.filter((g) => g.hostname).map((g) => [g.hostname as string, g]),
  );
  for (const h of containerHosts) {
    const g = byHostname.get(h.containerIdShort);
    if (g) claim(h.nodeId, g.id);
  }
  // Singleton fallback: exactly one unmatched garage node and one unmatched host.
  const unmatchedGarage = garageNodes.filter((g) => !used.has(g.id));
  const unmatchedHosts = containerHosts.filter((h) => !(h.nodeId in out));
  if (unmatchedGarage.length === 1 && unmatchedHosts.length === 1) {
    claim(unmatchedHosts[0]!.nodeId, unmatchedGarage[0]!.id);
  }
  return out;
}

/** Merge a discovered mapping into the row's `layout` JSON (additive, stable). */
export function mergeNodeMapping(
  layoutJson: unknown,
  mapping: Record<string, string>,
  defaultCapacityGb: number,
): { changed: boolean; next: Record<string, unknown> } {
  const base =
    layoutJson && typeof layoutJson === 'object' && !Array.isArray(layoutJson)
      ? { ...(layoutJson as Record<string, unknown>) }
      : {};
  const nodes =
    base.nodes && typeof base.nodes === 'object' && !Array.isArray(base.nodes)
      ? { ...(base.nodes as Record<string, { garageNodeId?: string; capacityGb?: number }>) }
      : {};
  let changed = false;
  for (const [nodeId, garageNodeId] of Object.entries(mapping)) {
    const cur = nodes[nodeId];
    if (cur?.garageNodeId === garageNodeId) continue;
    nodes[nodeId] = { ...cur, garageNodeId, capacityGb: cur?.capacityGb ?? defaultCapacityGb };
    changed = true;
  }
  return { changed, next: { ...base, nodes } };
}

// ── Layout planning (two-step: stage, then apply version+1) ──────────────────

export interface DesiredMember {
  nodeId: string;
  garageNodeId?: string;
  capacityGb: number;
}

export interface LayoutPlan {
  /** Role changes still to stage (POST /v1/layout). */
  stage: GarageLayoutChange[];
  /** Version to commit (POST /v1/layout/apply); null = nothing to converge. */
  applyVersion: number | null;
  /** Some members have no discovered garage id yet — removals are withheld. */
  incompleteMapping: boolean;
}

function changeKey(ch: GarageLayoutChange): string {
  return 'remove' in ch
    ? `${ch.id}|remove`
    : `${ch.id}|${ch.zone}|${ch.capacity}|${[...ch.tags].sort().join(',')}`;
}

/**
 * Diff desired members against the applied layout. Removals are staged ONLY
 * when every desired member's garage id is known — never drop a node we merely
 * failed to identify this tick. Changes already staged verbatim are not
 * re-staged, but still demand an apply.
 */
export function planLayout(
  orgId: string,
  desired: DesiredMember[],
  layout: GarageLayout,
): LayoutPlan {
  const desiredRoles = desired
    .filter((m): m is DesiredMember & { garageNodeId: string } => Boolean(m.garageNodeId))
    .map((m) => ({
      id: m.garageNodeId,
      zone: zoneFor(m.nodeId),
      capacity: m.capacityGb * 1_000_000_000,
      tags: [`org:${orgId}`],
    }));
  const incompleteMapping = desiredRoles.length !== desired.length;

  const rolesById = new Map(layout.roles.map((r) => [r.id, r]));
  const needed: GarageLayoutChange[] = [];
  for (const d of desiredRoles) {
    const cur = rolesById.get(d.id);
    if (!cur || cur.zone !== d.zone || cur.capacity !== d.capacity) needed.push(d);
  }
  if (!incompleteMapping) {
    const want = new Set(desiredRoles.map((d) => d.id));
    for (const r of layout.roles) {
      if (!want.has(r.id)) needed.push({ id: r.id, remove: true });
    }
  }
  needed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const stagedKeys = new Set(layout.staged.map(changeKey));
  const stage = needed.filter((ch) => !stagedKeys.has(changeKey(ch)));
  return {
    stage,
    applyVersion: needed.length > 0 ? layout.version + 1 : null,
    incompleteMapping,
  };
}

/** Deterministic identity of a plan — gates re-attempting identical failing work. */
export function planSignature(plan: LayoutPlan, layoutVersion: number): string {
  return createHash('sha256')
    .update(String(layoutVersion))
    .update('\n')
    .update(plan.stage.map(changeKey).join(';'))
    .update('\n')
    .update(String(plan.applyVersion ?? ''))
    .digest('hex')
    .slice(0, 16);
}

// ── Stats stamp (swarmy.storage.stats service label) ─────────────────────────

export interface StorageStats {
  at: string;
  layoutVersion: number | null;
  health: GarageHealth | null;
  nodes: Array<{
    garageNodeId: string;
    nodeId: string | null;
    up: boolean;
    draining: boolean;
    dataAvailableBytes: number | null;
    dataTotalBytes: number | null;
  }>;
}

export function buildStats(
  status: GarageStatus,
  health: GarageHealth | null,
  mapping: Record<string, string>,
  at: string,
): StorageStats {
  const nodeByGarageId = new Map(Object.entries(mapping).map(([n, g]) => [g, n]));
  return {
    at,
    layoutVersion: status.layoutVersion,
    health,
    nodes: status.nodes
      .map((g) => ({
        garageNodeId: g.id,
        nodeId: nodeByGarageId.get(g.id) ?? null,
        up: g.isUp,
        draining: g.draining,
        dataAvailableBytes: g.dataAvailableBytes,
        dataTotalBytes: g.dataTotalBytes,
      }))
      .sort((a, b) => (a.garageNodeId < b.garageNodeId ? -1 : 1)),
  };
}

/** Change-gate for the stamp: everything except the `at` timestamp. */
export function statsChanged(prevLabelValue: string | undefined, next: StorageStats): boolean {
  if (!prevLabelValue) return true;
  try {
    const prev = JSON.parse(prevLabelValue) as Partial<StorageStats>;
    const strip = ({ at: _at, ...rest }: Partial<StorageStats>): unknown => rest;
    return JSON.stringify(strip(prev)) !== JSON.stringify(strip(next));
  } catch {
    return true;
  }
}

// ── Failure backoff ───────────────────────────────────────────────────────────

/** Ticks to skip after N consecutive failures: 0, 1, 2, 4, 8, 8, … (cap 8). */
export function backoffTicks(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(2 ** (consecutiveFailures - 1), 8);
}
