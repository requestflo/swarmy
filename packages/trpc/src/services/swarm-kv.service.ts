/**
 * swarm-kv, controller side (plans/epic-docker-native-state.md §2b / P4).
 *
 * One {@link SwarmKv} per org (each org runs its own swarm), cached per hub so
 * reads are served from memory and the Docker round-trips go through that
 * org's manager agent (`config.list` / `config.inspect` / `config.create` /
 * `config.remove`). The controller has no Docker socket.
 *
 * Payloads are sealed with the vault (`encryptSecret`, SWARMY_SECRET_KEY).
 * Only the controller writes. A write with no manager connected fails loudly
 * (NO_MANAGER); it is never queued.
 *
 * Reads before the first load with no manager connected: an org with no
 * enrolled node has no swarm, so its store is honestly empty. An org whose
 * nodes exist but whose managers haven't dialled in yet gets NO_MANAGER rather
 * than a fake "nothing configured" that a reconciler could act on.
 *
 * Tests: {@link useMemoryKv} swaps in the in-memory Docker fake for a hub.
 */
import {
  KV_LABEL,
  KV_LABEL_BYTES,
  KV_LABEL_COLLECTION,
  KV_LABEL_ID,
  KV_LABEL_ORG,
  KV_LABEL_SEQ,
  KV_LABEL_SHA,
  KvError,
  SwarmKv,
  kvConfigName,
  kvFingerprint,
  memoryKvDriver,
  parseKvConfigName,
  plainKvSealer,
  stableJson,
  type KvConfigInfo,
  type KvDoc,
  type KvDriver,
  type KvExportDoc,
  type KvSealer,
} from '@swarmy/core';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type {
  ConfigInspectResult,
  ConfigListResult,
} from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import { TRPCError } from '@trpc/server';
import type { AgentHub } from '../hub/types';

/**
 * Every collection swarm-kv may hold — the raft-bloat lint (plan §6). Names are
 * ≤ 12 chars so `swarmy-kv.<collection>.<32-char id>.v<seq>` fits Docker's
 * 64-char config-name cap.
 */
export const KV_COLLECTIONS = [
  'ingress', // IngressConfig (id = orgId)
  'mesh', // MeshConfig (id = orgId)
  'geodns', // GeoDnsConfig (id = orgId)
  'dns-zone', // DnsZone + its DnsRecords (id = zone id)
  'obs', // ObservabilityConfig (id = orgId)
  'storage', // StorageCluster (id = orgId)
  'bucket-acl', // BucketAccess, every bucket of the org (id = orgId)
  'bkp-target', // BackupTarget (id = target id)
  'bkp-sched', // BackupSchedule (id = schedule id)
  'ctl-backup', // ControllerBackupConfig (id = "controller")
  'mirror', // OffsiteMirror (id = orgId)
  'registry', // RegistryConfig (id = orgId)
  'image-gc', // ImageGcPolicy (id = orgId)
  'stack', // Stack compose source (id = stack id)
  'rum', // RUM replay-store credential, vault-sealed (id = orgId)
] as const;
export type KvCollection = (typeof KV_COLLECTIONS)[number];

/** What a caller needs to reach an org's store (a request ctx or a worker's {db, hub}). */
export interface KvScope {
  hub: AgentHub;
  db?: DB;
}

const vaultSealer: KvSealer = { seal: encryptSecret, open: decryptSecret };

type DriverFactory = (orgId: string) => KvDriver;
interface HubKv {
  stores: Map<string, SwarmKv>;
  factory: DriverFactory;
  sealer: KvSealer;
}
const byHub = new WeakMap<object, HubKv>();

/** The controller's driver: Docker config calls routed through a manager agent. */
export function hubKvDriver(hub: AgentHub, orgId: string): KvDriver {
  const manager = (): string => {
    const id = hub.managerNode(orgId);
    if (!id) throw new KvError('UNAVAILABLE', 'no manager agent connected — swarm config is unavailable');
    return id;
  };
  return {
    async list(): Promise<KvConfigInfo[]> {
      const r = await hub.dispatch<ConfigListResult>(manager(), 'config.list', {});
      return (r?.configs ?? []).map((c) => ({ name: c.name, createdAt: c.createdAt, labels: c.labels ?? {} }));
    },
    async read(name) {
      const r = await hub.dispatch<ConfigInspectResult>(manager(), 'config.inspect', { name });
      return r.dataB64;
    },
    async create(name, dataB64, labels) {
      await hub.dispatch(manager(), 'config.create', { name, dataB64, labels });
    },
    async remove(name) {
      await hub.dispatch(manager(), 'config.remove', { name });
    },
  };
}

/**
 * Under `bun test` (NODE_ENV=test) a hub that hasn't opted in with
 * {@link useHubKv} gets the in-memory Docker fake, so service tests with a
 * hand-rolled hub don't have to script `config.*` dispatches. A context with
 * no hub at all shares one test store.
 */
const isTest = (): boolean => process.env.NODE_ENV === 'test';
const noHub = {};

type MemoryDriver = ReturnType<typeof memoryKvDriver>;

function memoryState(drivers = new Map<string, MemoryDriver>()): HubKv & { drivers: Map<string, MemoryDriver> } {
  return {
    stores: new Map(),
    sealer: plainKvSealer,
    drivers,
    factory: (orgId) => {
      let d = drivers.get(orgId);
      if (!d) drivers.set(orgId, (d = memoryKvDriver()));
      return d;
    },
  };
}

function hubState(hub: AgentHub | undefined): HubKv {
  const key = (hub ?? noHub) as object;
  let s = byHub.get(key);
  if (!s) {
    s = isTest() || !hub
      ? memoryState()
      : { stores: new Map(), factory: (orgId) => hubKvDriver(hub, orgId), sealer: vaultSealer };
    byHub.set(key, s);
  }
  return s;
}

/** Route this hub's stores through its manager agents (the production driver) — tests of the driver itself. */
export function useHubKv(hub: AgentHub): void {
  byHub.set(hub, { stores: new Map(), factory: (orgId) => hubKvDriver(hub, orgId), sealer: vaultSealer });
}

/** Raw per-org store (no fallback, no TRPC mapping) — backup/restore and tests. */
export function swarmKvFor(hub: AgentHub, orgId: string): SwarmKv {
  const s = hubState(hub);
  let kv = s.stores.get(orgId);
  if (!kv) {
    kv = new SwarmKv({ orgId, driver: s.factory(orgId), sealer: s.sealer, collections: KV_COLLECTIONS });
    s.stores.set(orgId, kv);
  }
  return kv;
}

/**
 * Test seam: back this hub's stores with the in-memory Docker fake (plaintext
 * sealer, so no SWARMY_SECRET_KEY is needed). Returns the per-org fakes.
 */
export function useMemoryKv(hub: AgentHub): Map<string, MemoryDriver> {
  const state = memoryState();
  byHub.set(hub, state);
  return state.drivers;
}

/**
 * Test seam: synchronously place a document (as version 1, or the next
 * version) into this hub's in-memory swarm, as if another controller wrote it.
 * The org's cache is dropped so the next read loads it.
 */
export function seedKv(hub: AgentHub | undefined, orgId: string, collection: KvCollection, id: string, value: unknown): void {
  const key = (hub ?? noHub) as object;
  let state = byHub.get(key) as (HubKv & { drivers?: Map<string, MemoryDriver> }) | undefined;
  if (!state?.drivers) {
    state = memoryState();
    byHub.set(key, state);
  }
  const driver = state.factory(orgId) as MemoryDriver;
  const seqs = [...driver.configs.keys()]
    .map((n) => parseKvConfigName(n))
    .filter((p) => p && p.collection === collection && p.id === id)
    .map((p) => p!.seq);
  const seq = Math.max(0, ...seqs) + 1;
  const dataB64 = Buffer.from(stableJson(value), 'utf8').toString('base64');
  driver.configs.set(kvConfigName(collection, id, seq), {
    dataB64,
    createdAt: Date.now(),
    labels: {
      [KV_LABEL]: '1',
      [KV_LABEL_ORG]: orgId,
      [KV_LABEL_COLLECTION]: collection,
      [KV_LABEL_ID]: id,
      [KV_LABEL_SEQ]: String(seq),
      [KV_LABEL_SHA]: kvFingerprint(stableJson(value)),
      [KV_LABEL_BYTES]: String(dataB64.length),
    },
  });
  state.stores.delete(orgId);
}

/** Forget an org's cache (e.g. after a controller restore wrote new documents). */
export function dropKvCache(hub: AgentHub, orgId?: string): void {
  const s = byHub.get((hub ?? noHub) as object);
  if (!s) return;
  if (orgId) s.stores.delete(orgId);
  else s.stores.clear();
}

/** KvError → the TRPCError a client sees. */
export function mapKvError(e: unknown): unknown {
  if (!(e instanceof KvError)) return e;
  switch (e.code) {
    case 'UNAVAILABLE':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message, cause: { swarmyCode: 'NO_MANAGER' } });
    case 'TOO_LARGE':
      return new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: e.message });
    case 'BUDGET':
      return new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: e.message });
    case 'CONFLICT':
      return new TRPCError({ code: 'CONFLICT', message: e.message });
    case 'NOT_FOUND':
      return new TRPCError({ code: 'NOT_FOUND', message: e.message });
    default:
      return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: e.message });
  }
}

async function hasNoSwarm(scope: KvScope, orgId: string): Promise<boolean> {
  if (!scope.db) return false;
  const n = await scope.db.node.count({ where: { orgId } }).catch(() => 1);
  return n === 0;
}

/**
 * The per-org handle every repository uses: typed collection access, the
 * "no swarm yet ⇒ empty" read fallback, and TRPC error mapping.
 */
export class OrgKv {
  constructor(
    private readonly scope: KvScope,
    readonly orgId: string,
  ) {}

  get raw(): SwarmKv {
    return swarmKvFor(this.scope.hub, this.orgId);
  }

  private async read<R>(fn: (kv: SwarmKv) => Promise<R>, empty: R): Promise<R> {
    if (pendingRestore.has(this.orgId)) {
      throw mapKvError(new KvError('UNAVAILABLE', 'swarm config is being restored from a controller backup — waiting for a manager agent'));
    }
    try {
      return await fn(this.raw);
    } catch (e) {
      if (e instanceof KvError && e.code === 'UNAVAILABLE' && !this.raw.loaded && (await hasNoSwarm(this.scope, this.orgId))) {
        return empty;
      }
      throw mapKvError(e);
    }
  }

  private async write<R>(fn: (kv: SwarmKv) => Promise<R>): Promise<R> {
    try {
      return await fn(this.raw);
    } catch (e) {
      throw mapKvError(e);
    }
  }

  get<T = unknown>(collection: KvCollection, id: string): Promise<T | null> {
    return this.read((kv) => kv.get<T>(collection, id), null);
  }

  getDoc<T = unknown>(collection: KvCollection, id: string): Promise<KvDoc<T> | null> {
    return this.read((kv) => kv.getDoc<T>(collection, id), null);
  }

  list<T = unknown>(collection: KvCollection): Promise<KvDoc<T>[]> {
    return this.read((kv) => kv.list<T>(collection), [] as KvDoc<T>[]);
  }

  put<T>(collection: KvCollection, id: string, value: T): Promise<KvDoc<T>> {
    return this.write((kv) => kv.put<T>(collection, id, value));
  }

  update<T>(
    collection: KvCollection,
    id: string,
    fn: (current: T | null) => T | undefined | Promise<T | undefined>,
  ): Promise<KvDoc<T> | null> {
    return this.write((kv) => kv.update<T>(collection, id, fn));
  }

  delete(collection: KvCollection, id: string): Promise<boolean> {
    return this.write((kv) => kv.delete(collection, id));
  }
}

/** The org's swarm-kv handle. `scope` is a request ctx or a worker's `{ db, hub }`. */
export function kvFor(scope: KvScope, orgId: string): OrgKv {
  return new OrgKv(scope, orgId);
}

/** A new document id (cuid-shaped: 'c' + 24 base36 chars, so it fits a config name). */
export function newKvId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return `c${Date.now().toString(36).slice(-8)}${s}`.slice(0, 25);
}

// ── controller backup bundle ──────────────────────────────────────────────────

/** Bundle section: every org's swarm-kv documents (plaintext; the bundle is passphrase-sealed). */
export interface KvBundleSection {
  version: 1;
  orgs: Array<{ orgId: string; docs: KvExportDoc[] }>;
}

/**
 * Snapshot every org's swarm-kv for the controller bundle. An org whose store
 * can't be reached (no manager online) is skipped and reported, never faked.
 */
export async function exportKvForBundle(
  hub: AgentHub,
  orgIds: readonly string[],
): Promise<{ section: KvBundleSection; skipped: string[] }> {
  const orgs: KvBundleSection['orgs'] = [];
  const skipped: string[] = [];
  for (const orgId of orgIds) {
    try {
      const docs = await swarmKvFor(hub, orgId).exportAll();
      if (docs.length) orgs.push({ orgId, docs });
    } catch {
      skipped.push(orgId);
    }
  }
  return { section: { version: 1, orgs }, skipped };
}

/** Write a bundle's swarm-kv documents back into (possibly fresh) swarms. */
export async function importKvFromBundle(
  hub: AgentHub,
  section: KvBundleSection,
): Promise<{ written: number; pending: string[] }> {
  let written = 0;
  const pending: string[] = [];
  for (const { orgId, docs } of section.orgs) {
    try {
      written += await swarmKvFor(hub, orgId).importAll(docs);
    } catch {
      pending.push(orgId); // no manager yet — the caller retries once one registers
    }
  }
  return { written, pending };
}

/** Test seam: the latest value of a document in this hub's in-memory swarm (synchronous), or null. */
export function peekKv<T = unknown>(hub: AgentHub | undefined, orgId: string, collection: KvCollection, id: string): T | null {
  const state = byHub.get((hub ?? noHub) as object) as (HubKv & { drivers?: Map<string, MemoryDriver> }) | undefined;
  const driver = state?.drivers?.get(orgId);
  if (!driver) return null;
  let best: { seq: number; dataB64: string } | null = null;
  for (const [name, c] of driver.configs) {
    const p = parseKvConfigName(name);
    if (!p || p.collection !== collection || p.id !== id) continue;
    if (!best || p.seq > best.seq) best = { seq: p.seq, dataB64: c.dataB64 };
  }
  return best ? (JSON.parse(Buffer.from(best.dataB64, 'base64').toString('utf8')) as T) : null;
}

// ── restore onto a fresh swarm ────────────────────────────────────────────────

/**
 * A restored bundle's swarm-kv section waits here (next to control.db) until
 * each org's manager agent is connected: the disaster-restore CLI has no hub,
 * and an in-place restore may run while some orgs' agents are still dialling
 * in. {@link importPendingKv} drains it.
 */
export const PENDING_KV_FILE = 'pending-swarm-kv.json';

/**
 * Orgs whose restored swarm-kv documents haven't been written back yet. Until
 * they are, their store reads as UNAVAILABLE (never as the fresh swarm's empty
 * store), so no reconciler acts on "nothing configured" mid-restore.
 */
const pendingRestore = new Set<string>();

export function isKvRestorePending(orgId: string): boolean {
  return pendingRestore.has(orgId);
}

export async function stashPendingKv(section: KvBundleSection, dataDir: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, PENDING_KV_FILE);
  await writeFile(file, JSON.stringify(section), { mode: 0o600 });
  for (const o of section.orgs) pendingRestore.add(o.orgId);
  return file;
}

/**
 * Import any stashed section into the orgs whose manager is connected; keeps
 * the rest for the next call. Returns what was written and who is still waiting.
 */
export async function importPendingKv(
  hub: AgentHub,
  dataDir: string,
): Promise<{ written: number; pending: string[] } | null> {
  const { readFile, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const file = join(dataDir, PENDING_KV_FILE);
  let section: KvBundleSection;
  try {
    section = JSON.parse(await readFile(file, 'utf8')) as KvBundleSection;
  } catch {
    return null; // nothing stashed
  }
  for (const o of section.orgs) pendingRestore.add(o.orgId);
  const ready = section.orgs.filter((o) => hub.managerNode(o.orgId));
  if (ready.length === 0) return { written: 0, pending: section.orgs.map((o) => o.orgId) };
  const res = await importKvFromBundle(hub, { version: 1, orgs: ready });
  const left = section.orgs.filter((o) => !ready.includes(o) || res.pending.includes(o.orgId));
  if (left.length === 0) await rm(file, { force: true });
  else await writeFile(file, JSON.stringify({ version: 1, orgs: left } satisfies KvBundleSection), { mode: 0o600 });
  for (const o of ready) {
    if (!left.includes(o)) pendingRestore.delete(o.orgId);
    dropKvCache(hub, o.orgId);
  }
  return { written: res.written, pending: left.map((o) => o.orgId) };
}

/** Test seam: seed Prisma-shaped rows (with `id`; Dates become ISO strings) into a collection. */
export function seedKvRows(
  hub: AgentHub | undefined,
  orgId: string,
  collection: KvCollection,
  rows: ReadonlyArray<Record<string, unknown>>,
): void {
  for (const row of rows) {
    const { id, orgId: _o, updatedAt: _u, ...rest } = row;
    const doc = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
    seedKv(hub, orgId, collection, String(id), doc);
  }
}

/** Test seam: every document of a collection in this hub's in-memory swarm, as rows (`id` + value; ISO dates → Date). */
export function peekKvRows(
  hub: AgentHub | undefined,
  orgId: string,
  collection: KvCollection,
  dateFields: readonly string[] = ['createdAt'],
): Array<Record<string, unknown>> {
  const state = byHub.get((hub ?? noHub) as object) as (HubKv & { drivers?: Map<string, MemoryDriver> }) | undefined;
  const driver = state?.drivers?.get(orgId);
  if (!driver) return [];
  const ids = new Set<string>();
  for (const name of driver.configs.keys()) {
    const p = parseKvConfigName(name);
    if (p?.collection === collection) ids.add(p.id);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const v = peekKv<Record<string, unknown>>(hub, orgId, collection, id);
    if (!v) continue;
    const row: Record<string, unknown> = { id, orgId, ...v };
    for (const f of dateFields) if (typeof row[f] === 'string') row[f] = new Date(row[f] as string);
    out.push(row);
  }
  return out.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
}

/** Test seam: make `hub` see the same (in-memory) swarm as `like` — one swarm, several hub fakes. */
export function shareKv(hub: AgentHub, like: AgentHub): void {
  const state = hubState(like);
  byHub.set(hub, state);
}
