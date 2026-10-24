/**
 * swarm-kv boot warm-up (plans/epic-docker-native-state.md §2b: "loaded into
 * memory at boot, after the first manager agent registers").
 *
 * Without it an org's store loads on its first read, so the first request or
 * reconciler tick pays for a `config.list` plus one `config.inspect` per
 * document, and a document that can't be opened (a different
 * SWARMY_SECRET_KEY, a hand-edited config) only shows up as a failed request.
 * The warmer loads every reachable org as soon as its manager is connected
 * and says so in the log, naming any broken document.
 *
 * Orgs whose restored documents are still pending are skipped
 * (`reachableOrgIds`); the restore drain drops their cache once written, so
 * the next pass loads the restored set. A failed org is retried every
 * `retryMs`, and the same error is logged once, not on every pass.
 */
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { reachableOrgIds } from './kv-repo';
import { swarmKvFor } from './swarm-kv.service';

export interface KvWarmOutcome {
  orgId: string;
  status: 'loaded' | 'failed';
  /** Documents loaded (0 on failure). */
  docs: number;
  /** Bytes held in raft across every retained version. */
  bytes: number;
  error?: string;
}

/** Load (or reload) one org's store and report what came in. */
export async function warmOrgKv(hub: AgentHub, orgId: string): Promise<KvWarmOutcome> {
  const kv = swarmKvFor(hub, orgId);
  try {
    await kv.refresh();
    const docs = await kv.describe();
    return { orgId, status: 'loaded', docs: docs.length, bytes: kv.footprint() };
  } catch (e) {
    return { orgId, status: 'failed', docs: 0, bytes: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

/** The boot log line for one outcome. */
export function warmLogLine(o: KvWarmOutcome, maxTotalBytes: number): string {
  if (o.status === 'loaded') {
    return `[swarm-kv] org ${o.orgId}: loaded ${o.docs} document(s), ${kb(o.bytes)} of ${kb(maxTotalBytes)} in raft`;
  }
  return `[swarm-kv] org ${o.orgId}: can't load swarm config: ${o.error ?? 'unknown error'}`;
}

export interface KvWarmerOptions {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** How long a failed org waits before the next attempt (ms). */
  retryMs?: number;
  now?: () => number;
}

/**
 * The warm-up loop's state: call `tick()` on a timer. Each tick loads every
 * reachable org whose store isn't loaded yet and returns what it did.
 */
export function createKvWarmer(scope: { hub: AgentHub; db: DB }, opts: KvWarmerOptions = {}) {
  /* eslint-disable no-console */
  const log = opts.log ?? ((l: string) => console.log(l));
  const error = opts.error ?? ((l: string) => console.error(l));
  const retryMs = opts.retryMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const failed = new Map<string, { at: number; error: string }>();

  return {
    async tick(): Promise<KvWarmOutcome[]> {
      const out: KvWarmOutcome[] = [];
      for (const orgId of await reachableOrgIds(scope)) {
        const kv = swarmKvFor(scope.hub, orgId);
        if (kv.loaded) {
          failed.delete(orgId);
          continue;
        }
        const prev = failed.get(orgId);
        if (prev && now() - prev.at < retryMs) continue;
        const o = await warmOrgKv(scope.hub, orgId);
        out.push(o);
        if (o.status === 'loaded') {
          failed.delete(orgId);
          log(warmLogLine(o, kv.limits.maxTotalBytes));
        } else {
          if (prev?.error !== o.error) error(warmLogLine(o, kv.limits.maxTotalBytes));
          failed.set(orgId, { at: now(), error: o.error ?? '' });
        }
      }
      return out;
    },
  };
}
