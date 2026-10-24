/**
 * swarm-kv versions: list an org's documents, show a document's retained
 * versions, and put one back (plans/epic-docker-native-state.md §2b: "the
 * retained versions double as a one-click undo config").
 *
 * Metadata only: values never leave the controller (they hold vault `*Ref`
 * blobs). A version's "changes" are the top-level field NAMES that differ from
 * the current version. A revert re-writes the older value as a new version
 * (the store's CAS write), so it is itself undoable, and is audited
 * `swarmkv.revert`.
 */
import { stableJson } from '@swarmy/core';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { KV_COLLECTIONS, isKvRestorePending, mapKvError, swarmKvFor, type KvCollection } from './swarm-kv.service';

export interface KvVersionView {
  seq: number;
  /** ISO time this version was written. */
  updatedAt: string;
  bytes: number;
}

export interface KvDocView extends KvVersionView {
  collection: string;
  id: string;
  /** The document's own `name` (a destination, an app) or `volume`, when it has one. */
  name: string | null;
  /** Every retained version, newest first (the first is the current one). */
  versions: KvVersionView[];
}

export interface KvDocsView {
  /** False when the org's swarm can't be read now (no manager, or a restore is still writing). */
  available: boolean;
  reason: string | null;
  docs: KvDocView[];
  footprintBytes: number;
  maxDocBytes: number;
  maxTotalBytes: number;
  keepVersions: number;
}

const iso = (ms: number): string => new Date(ms || 0).toISOString();

function nameOf(value: unknown): string | null {
  const v = value as Record<string, unknown> | null;
  if (typeof v?.name === 'string') return v.name;
  return typeof v?.volume === 'string' ? v.volume : null;
}

function collectionOf(collection: string): KvCollection {
  if (!(KV_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown swarm config collection "${collection}"` });
  }
  return collection as KvCollection;
}

export async function listKvDocs(ctx: OrgContext): Promise<KvDocsView> {
  const kv = swarmKvFor(ctx.hub, ctx.activeOrgId);
  const base = { footprintBytes: 0, ...kv.limits, docs: [] as KvDocView[] };
  if (isKvRestorePending(ctx.activeOrgId)) {
    return { ...base, available: false, reason: 'swarm config is being restored from a controller backup' };
  }
  if (!kv.loaded && !ctx.hub.managerNode(ctx.activeOrgId)) {
    return { ...base, available: false, reason: 'no manager server is connected, so the swarm’s config can’t be read' };
  }
  try {
    const metas = await kv.describe();
    const docs: KvDocView[] = [];
    for (const m of metas) {
      const value = await kv.get(m.collection, m.id).catch(() => null);
      docs.push({
        collection: m.collection,
        id: m.id,
        name: nameOf(value),
        seq: m.seq,
        updatedAt: iso(m.updatedAt),
        bytes: m.bytes,
        versions: m.versions.map((v) => ({ seq: v.seq, updatedAt: iso(v.updatedAt), bytes: v.bytes })),
      });
    }
    return { ...base, available: true, reason: null, docs, footprintBytes: kv.footprint() };
  } catch (e) {
    throw mapKvError(e);
  }
}

/** Top-level fields whose value differs between two document versions. */
export function changedFields(a: unknown, b: unknown): string[] {
  const x = (a ?? {}) as Record<string, unknown>;
  const y = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => stableJson(x[k] ?? null) !== stableJson(y[k] ?? null))
    .sort();
}

export interface KvDocVersionView extends KvVersionView {
  current: boolean;
  /** Fields a put-back of this version would change (empty for the current one). */
  changes: string[];
}

export async function kvDocVersions(
  ctx: OrgContext,
  input: { collection: string; id: string },
): Promise<KvDocVersionView[]> {
  const collection = collectionOf(input.collection);
  const kv = swarmKvFor(ctx.hub, ctx.activeOrgId);
  try {
    const metas = (await kv.describe()).find((m) => m.collection === collection && m.id === input.id);
    if (!metas) throw new TRPCError({ code: 'NOT_FOUND', message: `no swarm config ${collection}/${input.id}` });
    const current = await kv.get(collection, input.id);
    const out: KvDocVersionView[] = [];
    for (const v of metas.versions) {
      const isCurrent = v.seq === metas.seq;
      const value = isCurrent ? current : await kv.getVersion(collection, input.id, v.seq);
      out.push({ seq: v.seq, updatedAt: iso(v.updatedAt), bytes: v.bytes, current: isCurrent, changes: isCurrent ? [] : changedFields(current, value) });
    }
    return out;
  } catch (e) {
    throw mapKvError(e);
  }
}

export interface KvRevertResult {
  collection: string;
  id: string;
  /** The version that was put back. */
  restoredFrom: number;
  /** The new current version (equal to the old one when nothing changed). */
  seq: number;
  changed: boolean;
}

export async function revertKvDoc(
  ctx: OrgContext,
  input: { collection: string; id: string; seq: number },
): Promise<KvRevertResult> {
  const collection = collectionOf(input.collection);
  const kv = swarmKvFor(ctx.hub, ctx.activeOrgId);
  try {
    const versions = await kv.versions(collection, input.id);
    const latest = versions[0]?.seq;
    if (latest === undefined) throw new TRPCError({ code: 'NOT_FOUND', message: `no swarm config ${collection}/${input.id}` });
    if (input.seq === latest) throw new TRPCError({ code: 'BAD_REQUEST', message: `v${input.seq} is already the current version` });
    if (!versions.some((v) => v.seq === input.seq)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `v${input.seq} is no longer kept (swarmy keeps the last ${kv.limits.keepVersions})` });
    }
    const doc = await kv.revert(collection, input.id, input.seq);
    const result = { collection, id: input.id, restoredFrom: input.seq, seq: doc.seq, changed: doc.seq !== latest };
    await writeAudit(ctx, {
      action: 'swarmkv.revert',
      targetType: 'kvDoc',
      targetId: `${collection}/${input.id}`,
      metadata: { collection, id: input.id, from: latest, to: input.seq, newSeq: doc.seq, changed: result.changed },
    });
    return result;
  } catch (e) {
    throw mapKvError(e);
  }
}
