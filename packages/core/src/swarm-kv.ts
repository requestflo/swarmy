/**
 * swarm-kv — a small versioned document store on Docker Swarm configs
 * (plans/epic-docker-native-state.md §2b, P4).
 *
 * The swarm's raft store holds swarmy's class-(b) infra config: small,
 * human-speed desired state a reconciler converges (ingress/mesh/DNS settings,
 * backup targets, registry policy, compose sources, …). It survives loss of the
 * controller's volume because every manager holds raft.
 *
 * Layout. One document version = one Docker config:
 *
 *     swarmy-kv.<collection>.<id>.v<seq>
 *
 * labelled `swarmy.kv=1`, `swarmy.kv.org`, `swarmy.kv.collection`,
 * `swarmy.kv.id`, `swarmy.kv.seq`, `swarmy.kv.sha` (content fingerprint) and
 * `swarmy.kv.bytes` (stored payload size). The latest version is the highest
 * `seq`. Configs are immutable, so every change is a new object.
 *
 * Optimistic concurrency for free: config names are unique in raft, so a write
 * of `seq+1` that loses a race fails with "already exists". The writer re-reads
 * the key and re-applies its change (bounded retries).
 *
 * Budget: ≤ {@link KV_MAX_DOC_BYTES} per stored document and ≤
 * {@link KV_MAX_TOTAL_BYTES} across every retained version, so manager raft
 * snapshots stay small. Only the last {@link KV_KEEP_VERSIONS} versions are
 * kept (older ones are garbage-collected after each write); they double as
 * "undo to a previous version".
 *
 * Rules. Only the controller writes. Payloads are sealed (vault-encrypted) by
 * the injected {@link KvSealer} — this module never imports `node:crypto`, so
 * it stays browser-safe for the `@swarmy/core` barrel. No timestamps, counters
 * or run state go into raft: `updatedAt` / `last*` / `next*At` top-level fields
 * are rejected; a document's update time is its latest config's Docker
 * `CreatedAt`, reported back as {@link KvDoc.updatedAt}.
 *
 * Reads are served from an in-memory cache loaded on first use and refreshed in
 * the background every `refreshMs`. The controller has no Docker socket, so
 * the {@link KvDriver} is injected: the controller's driver dispatches
 * `config.*` commands to a manager agent; tests inject an in-memory fake; the
 * integration test drives a real local swarm via `DockerClient`.
 */

// ── limits ────────────────────────────────────────────────────────────────────

/** Per-document ceiling on the stored (sealed, base64) payload. */
export const KV_MAX_DOC_BYTES = 64 * 1024;
/** Ceiling on swarmy's whole swarm-kv raft footprint (every retained version). */
export const KV_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Versions retained per document (latest included). */
export const KV_KEEP_VERSIONS = 3;
/** Docker caps config names at 64 characters. */
export const KV_NAME_MAX = 64;
export const KV_NAME_PREFIX = 'swarmy-kv';
/** Highest version number (6 digits keeps names ≤ 64 chars; a human-speed doc never gets near it). */
export const KV_MAX_SEQ = 999_999;

export const KV_LABEL = 'swarmy.kv';
export const KV_LABEL_ORG = 'swarmy.kv.org';
export const KV_LABEL_COLLECTION = 'swarmy.kv.collection';
export const KV_LABEL_ID = 'swarmy.kv.id';
export const KV_LABEL_SEQ = 'swarmy.kv.seq';
export const KV_LABEL_SHA = 'swarmy.kv.sha';
export const KV_LABEL_BYTES = 'swarmy.kv.bytes';

const COLLECTION_RE = /^[a-z][a-z0-9-]{0,11}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const NAME_RE = /^swarmy-kv\.([a-z][a-z0-9-]{0,11})\.([A-Za-z0-9][A-Za-z0-9_-]{0,39})\.v(\d{1,6})$/;
/** Run state has no place in raft — see the module header. */
const FORBIDDEN_FIELD_RE = /^(updatedAt|last[A-Z]\w*|next[A-Z]\w*At)$/;

// ── errors ────────────────────────────────────────────────────────────────────

export class KvError extends Error {
  constructor(
    readonly code: 'UNAVAILABLE' | 'TOO_LARGE' | 'BUDGET' | 'CONFLICT' | 'INVALID' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'KvError';
  }
}

export function isKvError(e: unknown, code?: KvError['code']): e is KvError {
  return e instanceof KvError && (code === undefined || e.code === code);
}

/** True for Docker's "config name already exists" rejection (via the agent's message too). */
export function isNameConflict(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /already exists|conflicts with an existing|name conflict|code = AlreadyExists|\b409\b/i.test(msg);
}

// ── driver + sealer seams ─────────────────────────────────────────────────────

/** One Docker config as listed (no data). `createdAt` is ms epoch. */
export interface KvConfigInfo {
  name: string;
  createdAt: number;
  labels: Record<string, string>;
}

/**
 * The four Docker config operations swarm-kv needs. `create` MUST reject when
 * the name already exists (Docker does) — that rejection is the CAS.
 */
export interface KvDriver {
  list(): Promise<KvConfigInfo[]>;
  /** The config's `Spec.Data`, base64. */
  read(name: string): Promise<string>;
  create(name: string, dataB64: string, labels: Record<string, string>): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Payload encryption (the controller passes the vault's encryptSecret/decryptSecret). */
export interface KvSealer {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/** Test/dev sealer: no encryption. Never used by the controller. */
export const plainKvSealer: KvSealer = { seal: (s) => s, open: (s) => s };

// ── codec ─────────────────────────────────────────────────────────────────────

export function kvConfigName(collection: string, id: string, seq: number): string {
  return `${KV_NAME_PREFIX}.${collection}.${id}.v${seq}`;
}

export function parseKvConfigName(
  name: string,
): { collection: string; id: string; seq: number } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const seq = Number.parseInt(m[3]!, 10);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  return { collection: m[1]!, id: m[2]!, seq };
}

export function assertKvKey(collection: string, id: string): void {
  if (!COLLECTION_RE.test(collection)) throw new KvError('INVALID', `invalid swarm-kv collection "${collection}"`);
  if (!ID_RE.test(id)) throw new KvError('INVALID', `invalid swarm-kv id "${id}"`);
  // Room for the longest seq we will ever write.
  if (kvConfigName(collection, id, KV_MAX_SEQ).length > KV_NAME_MAX) {
    throw new KvError('INVALID', `swarm-kv key ${collection}/${id} is too long for a Docker config name`);
  }
}

/** FNV-1a 32-bit — a change fingerprint (skip no-op writes), not a security hash. */
export function kvFingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function toB64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function fromB64(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}

/** Stable JSON (sorted object keys) so the fingerprint ignores key order. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return val;
  });
}

function assertNoRunState(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const k of Object.keys(value)) {
    if (FORBIDDEN_FIELD_RE.test(k)) {
      throw new KvError('INVALID', `swarm-kv documents hold desired config only — "${k}" is run state`);
    }
  }
}

// ── store ─────────────────────────────────────────────────────────────────────

/** A document as read back: the value plus its version metadata. */
export interface KvDoc<T> {
  collection: string;
  id: string;
  seq: number;
  value: T;
  /** Docker CreatedAt of the latest version (ms epoch) — the document's update time. */
  updatedAt: number;
}

interface VersionMeta {
  seq: number;
  bytes: number;
  sha: string;
  createdAt: number;
}

interface Entry {
  /** Every known version, ascending by seq. */
  versions: VersionMeta[];
  /** The latest version's decoded value (null only transiently). */
  value: unknown;
}

export interface SwarmKvOptions {
  orgId: string;
  driver: KvDriver;
  sealer: KvSealer;
  /** When set, only these collections may be used (typos can't grow raft). */
  collections?: readonly string[];
  maxDocBytes?: number;
  maxTotalBytes?: number;
  keepVersions?: number;
  /** Background refresh interval for the read cache (ms). 0 = refresh on every read. */
  refreshMs?: number;
  maxRetries?: number;
  now?: () => number;
}

/** Export row for the controller backup bundle (plaintext value — the bundle is encrypted). */
export interface KvExportDoc {
  collection: string;
  id: string;
  value: unknown;
}

const keyOf = (collection: string, id: string) => `${collection}\u0000${id}`;

/**
 * One org's swarm-kv. The controller keeps one instance per org (each org has
 * its own swarm) and routes every Docker call through that org's manager agent.
 */
export class SwarmKv {
  readonly orgId: string;
  private readonly driver: KvDriver;
  private readonly sealer: KvSealer;
  private readonly allowed: ReadonlySet<string> | null;
  private readonly maxDocBytes: number;
  private readonly maxTotalBytes: number;
  private readonly keep: number;
  private readonly refreshMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;

  private entries = new Map<string, Entry>();
  private loadedAt: number | null = null;
  private loading: Promise<void> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Bumped on every local write/delete; a refresh never clobbers a key touched after it started. */
  private gen = 0;
  private touched = new Map<string, number>();

  constructor(opts: SwarmKvOptions) {
    this.orgId = opts.orgId;
    this.driver = opts.driver;
    this.sealer = opts.sealer;
    this.allowed = opts.collections ? new Set(opts.collections) : null;
    this.maxDocBytes = opts.maxDocBytes ?? KV_MAX_DOC_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? KV_MAX_TOTAL_BYTES;
    this.keep = Math.max(1, opts.keepVersions ?? KV_KEEP_VERSIONS);
    this.refreshMs = opts.refreshMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.now = opts.now ?? Date.now;
  }

  get loaded(): boolean {
    return this.loadedAt !== null;
  }

  /** Bytes held in raft across every retained version this store knows of. */
  footprint(): number {
    let n = 0;
    for (const e of this.entries.values()) for (const v of e.versions) n += v.bytes;
    return n;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** Load (first call) or background-refresh a stale cache; reads never wait on a refresh. */
  async ensureFresh(): Promise<void> {
    if (this.loadedAt === null) return this.refresh();
    if (this.now() - this.loadedAt >= this.refreshMs && !this.loading) {
      void this.refresh().catch(() => undefined); // stale-while-revalidate
    }
  }

  /** Re-list the swarm and pull any version this cache hasn't seen. */
  refresh(): Promise<void> {
    if (!this.loading) {
      this.loading = this.doRefresh().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async doRefresh(): Promise<void> {
    const startGen = this.gen;
    const listed = await this.listMine();
    const next = new Map<string, Entry>();
    for (const [k, versions] of listed) {
      const latest = versions[versions.length - 1]!;
      const cur = this.entries.get(k);
      const curLatest = cur?.versions[cur.versions.length - 1];
      if (cur && curLatest && curLatest.seq === latest.seq) {
        next.set(k, { versions, value: cur.value });
        continue;
      }
      const [collection, id] = k.split('\u0000') as [string, string];
      const value = await this.readVersion(collection, id, latest.seq);
      next.set(k, { versions, value });
    }
    // A local write/delete that landed while we were listing wins over the listing.
    for (const [k, g] of this.touched) {
      if (g <= startGen) continue;
      const cur = this.entries.get(k);
      if (cur) next.set(k, cur);
      else next.delete(k);
    }
    this.touched.clear();
    this.entries = next;
    this.loadedAt = this.now();
  }

  private touch(k: string): void {
    this.gen += 1;
    this.touched.set(k, this.gen);
  }

  /** The latest value, or null when the document doesn't exist. */
  async get<T = unknown>(collection: string, id: string): Promise<T | null> {
    return (await this.getDoc<T>(collection, id))?.value ?? null;
  }

  async getDoc<T = unknown>(collection: string, id: string): Promise<KvDoc<T> | null> {
    this.check(collection, id);
    await this.ensureFresh();
    return this.docOf<T>(collection, id);
  }

  /** Every document in a collection (latest versions), ordered by id. */
  async list<T = unknown>(collection: string): Promise<KvDoc<T>[]> {
    this.checkCollection(collection);
    await this.ensureFresh();
    const out: KvDoc<T>[] = [];
    for (const k of this.entries.keys()) {
      const [c, id] = k.split('\u0000') as [string, string];
      if (c !== collection) continue;
      const d = this.docOf<T>(c, id);
      if (d) out.push(d);
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Retained version numbers of one document, newest first (the "undo" list). */
  async versions(collection: string, id: string): Promise<Array<{ seq: number; updatedAt: number }>> {
    this.check(collection, id);
    await this.ensureFresh();
    const e = this.entries.get(keyOf(collection, id));
    return (e?.versions ?? []).map((v) => ({ seq: v.seq, updatedAt: v.createdAt })).reverse();
  }

  /** Read one retained (possibly older) version's value. */
  async getVersion<T = unknown>(collection: string, id: string, seq: number): Promise<T> {
    this.check(collection, id);
    return (await this.readVersion(collection, id, seq)) as T;
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** Write `value` as the new latest version (last-writer-wins over the latest). */
  async put<T>(collection: string, id: string, value: T): Promise<KvDoc<T>> {
    const doc = await this.update<T>(collection, id, () => value);
    return doc!;
  }

  /**
   * Compare-and-swap update: `fn` gets the current value (null = absent) and
   * returns the next one. On a lost race the key is re-read and `fn` re-run.
   * Returning `undefined` means "no change". An unchanged value writes nothing.
   */
  async update<T>(
    collection: string,
    id: string,
    fn: (current: T | null) => T | undefined | Promise<T | undefined>,
  ): Promise<KvDoc<T> | null> {
    this.check(collection, id);
    return this.serial(async () => {
      await this.ensureFresh();
      for (let attempt = 0; ; attempt++) {
        const cur = this.entries.get(keyOf(collection, id));
        const curLatest = cur?.versions[cur.versions.length - 1];
        const next = await fn(curLatest ? (structuredClone(cur!.value) as T) : null);
        if (next === undefined) return this.docOf<T>(collection, id);
        assertNoRunState(next);
        const json = stableJson(next);
        const sha = kvFingerprint(json);
        if (curLatest && curLatest.sha === sha) return this.docOf<T>(collection, id);

        const dataB64 = toB64(this.sealer.seal(json));
        const bytes = dataB64.length;
        if (bytes > this.maxDocBytes) {
          throw new KvError(
            'TOO_LARGE',
            `swarm-kv document ${collection}/${id} is ${bytes} bytes (limit ${this.maxDocBytes})`,
          );
        }
        const seq = (curLatest?.seq ?? 0) + 1;
        if (seq > KV_MAX_SEQ) throw new KvError('INVALID', `swarm-kv ${collection}/${id} ran out of version numbers`);
        const prior = cur?.versions ?? [];
        const pruned = prior.slice(0, Math.max(0, prior.length + 1 - this.keep));
        const projected = this.footprint() + bytes - pruned.reduce((n, v) => n + v.bytes, 0);
        if (projected > this.maxTotalBytes) {
          throw new KvError(
            'BUDGET',
            `swarm-kv footprint would reach ${projected} bytes (limit ${this.maxTotalBytes}) — refusing to grow raft`,
          );
        }
        const labels = {
          [KV_LABEL]: '1',
          [KV_LABEL_ORG]: this.orgId,
          [KV_LABEL_COLLECTION]: collection,
          [KV_LABEL_ID]: id,
          [KV_LABEL_SEQ]: String(seq),
          [KV_LABEL_SHA]: sha,
          [KV_LABEL_BYTES]: String(bytes),
        };
        try {
          await this.driver.create(kvConfigName(collection, id, seq), dataB64, labels);
        } catch (e) {
          if (!isNameConflict(e)) throw e;
          if (attempt >= this.maxRetries) {
            throw new KvError('CONFLICT', `swarm-kv ${collection}/${id}: gave up after ${attempt + 1} conflicting writes`);
          }
          await this.refreshKey(collection, id);
          await new Promise((r) => setTimeout(r, Math.min(200, 10 * 2 ** attempt) * Math.random()));
          continue;
        }
        const meta: VersionMeta = { seq, bytes, sha, createdAt: this.now() };
        const versions = [...prior, meta];
        this.entries.set(keyOf(collection, id), { versions, value: JSON.parse(json) as unknown });
        this.touch(keyOf(collection, id));
        await this.gc(collection, id);
        return this.docOf<T>(collection, id);
      }
    });
  }

  /** Remove a document (every version, oldest first so a crash never resurrects an old one). */
  async delete(collection: string, id: string): Promise<boolean> {
    this.check(collection, id);
    return this.serial(async () => {
      await this.ensureFresh();
      await this.refreshKey(collection, id);
      const e = this.entries.get(keyOf(collection, id));
      if (!e) return false;
      for (const v of e.versions) {
        await this.removeQuietly(kvConfigName(collection, id, v.seq));
      }
      this.entries.delete(keyOf(collection, id));
      this.touch(keyOf(collection, id));
      return true;
    });
  }

  /** "Undo": re-write a retained older version as the new latest. */
  async revert<T>(collection: string, id: string, seq: number): Promise<KvDoc<T>> {
    const old = await this.getVersion<T>(collection, id, seq);
    return this.put<T>(collection, id, old);
  }

  // ── backup / restore ───────────────────────────────────────────────────────

  /** Every latest document (plaintext) for the controller backup bundle. */
  async exportAll(): Promise<KvExportDoc[]> {
    await this.refresh();
    const out: KvExportDoc[] = [];
    for (const [k, e] of this.entries) {
      const [collection, id] = k.split('\u0000') as [string, string];
      out.push({ collection, id, value: structuredClone(e.value) });
    }
    return out.sort((a, b) =>
      a.collection === b.collection ? (a.id < b.id ? -1 : 1) : a.collection < b.collection ? -1 : 1,
    );
  }

  /** Write bundle documents back into (a possibly fresh) swarm. Returns docs written. */
  async importAll(docs: readonly KvExportDoc[]): Promise<number> {
    let n = 0;
    for (const d of docs) {
      if (this.allowed && !this.allowed.has(d.collection)) continue;
      await this.put(d.collection, d.id, d.value);
      n += 1;
    }
    return n;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private checkCollection(collection: string): void {
    if (this.allowed && !this.allowed.has(collection)) {
      throw new KvError('INVALID', `swarm-kv collection "${collection}" is not allowlisted`);
    }
    if (!COLLECTION_RE.test(collection)) throw new KvError('INVALID', `invalid swarm-kv collection "${collection}"`);
  }

  private check(collection: string, id: string): void {
    this.checkCollection(collection);
    assertKvKey(collection, id);
  }

  private docOf<T>(collection: string, id: string): KvDoc<T> | null {
    const e = this.entries.get(keyOf(collection, id));
    const latest = e?.versions[e.versions.length - 1];
    if (!e || !latest) return null;
    return { collection, id, seq: latest.seq, value: structuredClone(e.value) as T, updatedAt: latest.createdAt };
  }

  /** All of this org's swarm-kv versions, grouped by key, ascending by seq. */
  private async listMine(): Promise<Map<string, VersionMeta[]>> {
    const all = await this.driver.list();
    const byKey = new Map<string, VersionMeta[]>();
    for (const c of all) {
      if (c.labels[KV_LABEL] !== '1' || c.labels[KV_LABEL_ORG] !== this.orgId) continue;
      const parsed = parseKvConfigName(c.name);
      if (!parsed) continue;
      if (this.allowed && !this.allowed.has(parsed.collection)) continue;
      const k = keyOf(parsed.collection, parsed.id);
      const list = byKey.get(k) ?? [];
      list.push({
        seq: parsed.seq,
        bytes: Number.parseInt(c.labels[KV_LABEL_BYTES] ?? '0', 10) || 0,
        sha: c.labels[KV_LABEL_SHA] ?? '',
        createdAt: c.createdAt,
      });
      byKey.set(k, list);
    }
    for (const list of byKey.values()) list.sort((a, b) => a.seq - b.seq);
    return byKey;
  }

  /** Re-read one key from the swarm (after a lost CAS, before a delete). */
  private async refreshKey(collection: string, id: string): Promise<void> {
    const k = keyOf(collection, id);
    const versions = (await this.listMine()).get(k);
    this.touch(k);
    if (!versions?.length) {
      this.entries.delete(k);
      return;
    }
    const latest = versions[versions.length - 1]!;
    const value = await this.readVersion(collection, id, latest.seq);
    this.entries.set(k, { versions, value });
  }

  private async readVersion(collection: string, id: string, seq: number): Promise<unknown> {
    const dataB64 = await this.driver.read(kvConfigName(collection, id, seq));
    try {
      return JSON.parse(this.sealer.open(fromB64(dataB64))) as unknown;
    } catch (e) {
      throw new KvError(
        'INVALID',
        `swarm-kv ${collection}/${id} v${seq} can't be opened (${e instanceof Error ? e.message : String(e)}) — is SWARMY_SECRET_KEY the one that wrote it?`,
      );
    }
  }

  /** Keep the newest `keep` versions; best-effort removal of the rest. */
  private async gc(collection: string, id: string): Promise<void> {
    const k = keyOf(collection, id);
    const e = this.entries.get(k);
    if (!e || e.versions.length <= this.keep) return;
    const drop = e.versions.slice(0, e.versions.length - this.keep);
    const kept: VersionMeta[] = e.versions.slice(e.versions.length - this.keep);
    for (const v of drop) {
      const ok = await this.removeQuietly(kvConfigName(collection, id, v.seq));
      if (!ok) kept.unshift(v); // still in raft: keep counting it against the budget
    }
    this.entries.set(k, { versions: kept.sort((a, b) => a.seq - b.seq), value: e.value });
  }

  private async removeQuietly(name: string): Promise<boolean> {
    try {
      await this.driver.remove(name);
      return true;
    } catch (e) {
      return /not found|no such/i.test(e instanceof Error ? e.message : String(e));
    }
  }
}

// ── in-memory driver (tests, demo) ────────────────────────────────────────────

/**
 * A fake swarm config API with Docker's semantics (unique names, immutable
 * data). `faults` lets tests inject a racing writer or a failing call.
 */
export function memoryKvDriver(opts?: { now?: () => number }): KvDriver & {
  configs: Map<string, { dataB64: string; labels: Record<string, string>; createdAt: number }>;
  calls: string[];
  beforeCreate?: (name: string) => void | Promise<void>;
} {
  const now = opts?.now ?? Date.now;
  const configs = new Map<string, { dataB64: string; labels: Record<string, string>; createdAt: number }>();
  const calls: string[] = [];
  const driver = {
    configs,
    calls,
    beforeCreate: undefined as ((name: string) => void | Promise<void>) | undefined,
    async list() {
      calls.push('list');
      return [...configs].map(([name, c]) => ({ name, createdAt: c.createdAt, labels: { ...c.labels } }));
    },
    async read(name: string) {
      calls.push(`read ${name}`);
      const c = configs.get(name);
      if (!c) throw new Error(`config ${name} not found`);
      return c.dataB64;
    },
    async create(name: string, dataB64: string, labels: Record<string, string>) {
      calls.push(`create ${name}`);
      await driver.beforeCreate?.(name);
      if (configs.has(name)) throw new Error(`rpc error: code = AlreadyExists desc = config ${name} already exists`);
      configs.set(name, { dataB64, labels: { ...labels }, createdAt: now() });
    },
    async remove(name: string) {
      calls.push(`remove ${name}`);
      if (!configs.delete(name)) throw new Error(`config ${name} not found`);
    },
  };
  return driver;
}
