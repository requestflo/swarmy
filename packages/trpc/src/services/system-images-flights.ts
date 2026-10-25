/**
 * One copy of a system image into an org's registry at a time. Two callers
 * pre-copy images: the `system-image-mirror` worker (boot + every 6h) and the
 * platform upgrade's preflight. Both read the same mirror labels, which are
 * only stamped once a copy finishes, so a preflight that started while a
 * mirror tick was copying started the same copies again (nightly e2e: about
 * 30 images copied twice at once).
 *
 * Per org, each image in flight is keyed by what is copied (BOM key + source
 * ref, digest-pinned when the BOM pins one). A caller starts only the images
 * nobody is copying yet and waits for the rest, so the result covers its whole
 * list. A finished copy leaves the map: it is not a cache — the next caller
 * reads the labels the copy stamped.
 *
 * In-process only (one controller holds the lease). Tested in
 * `system-images-flights.test.ts`.
 */
import { copySourceFor, type SystemImage, type SystemImageKey } from '@swarmy/core/system-images';

export interface CopyOutcome {
  /** Key → digest that landed in the registry. */
  ok: Map<SystemImageKey, string>;
  failed: SystemImageKey[];
}

export type CopyBatch = (items: SystemImage[]) => Promise<CopyOutcome>;
export type Flights = Map<string, Map<string, Promise<CopyOutcome>>>;

const FLIGHTS: Flights = new Map();

/** What one copy is: the BOM key and the exact upstream source. */
export function copyIdentity(img: SystemImage): string {
  return `${img.key} ${copySourceFor(img)}`;
}

/**
 * Copy `todo` into `orgId`'s registry, sharing any copy already in flight.
 * Rejects when this caller's own batch fails (as before); an image another
 * caller's failed batch was copying is reported as failed.
 */
export async function copyOnce(
  orgId: string,
  todo: readonly SystemImage[],
  copy: CopyBatch,
  flights: Flights = FLIGHTS,
): Promise<CopyOutcome & { joined: SystemImageKey[] }> {
  if (todo.length === 0) return { ok: new Map(), failed: [], joined: [] };
  const org = flights.get(orgId) ?? new Map<string, Promise<CopyOutcome>>();
  flights.set(orgId, org);
  const unique = [...new Map(todo.map((img) => [copyIdentity(img), img])).values()];
  const mine = unique.filter((img) => !org.has(copyIdentity(img)));
  const joined = unique.filter((img) => !mine.includes(img)).map((img) => ({ img, flight: org.get(copyIdentity(img))! }));

  let batch: Promise<CopyOutcome> | undefined;
  if (mine.length > 0) {
    const ids = mine.map(copyIdentity);
    // Leaves the map as it settles, before any caller sees the result.
    const run: Promise<CopyOutcome> = copy(mine).finally(() => {
      for (const id of ids) if (org.get(id) === run) org.delete(id);
      if (org.size === 0 && flights.get(orgId) === org) flights.delete(orgId);
    });
    for (const id of ids) org.set(id, run);
    batch = run;
  }

  const ok = new Map<SystemImageKey, string>();
  const failed: SystemImageKey[] = [];
  const take = (img: SystemImage, out: CopyOutcome | null) => {
    const digest = out?.ok.get(img.key);
    if (digest) ok.set(img.key, digest);
    else failed.push(img.key);
  };
  const others = await Promise.all(joined.map(({ flight }) => flight.catch(() => null)));
  joined.forEach(({ img }, i) => take(img, others[i]!));
  if (batch) {
    const own = await batch;
    for (const img of mine) take(img, own);
  }
  return { ok, failed, joined: joined.map(({ img }) => img.key) };
}
