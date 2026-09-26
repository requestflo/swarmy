/**
 * Pure accounting over Docker's pull progress stream, for the Deploying
 * screen's "Get the image" step: how many layers, how many are done, how
 * many bytes so far. Fed one `docker pull` JSON event at a time.
 *
 * Only per-layer events count (they carry the layer id); the whole-image
 * lines ("Pulling from library/ghost", "Digest: …", "Status: …") carry the
 * tag or nothing and are ignored here.
 */
import type { PullProgressEvent } from '@swarmy/core/docker';

interface Layer {
  done: boolean;
  total: number;
  current: number;
}

export interface LayerTally {
  layers: Map<string, Layer>;
  /** "Status: Image is up to date for …" — nothing needed downloading. */
  upToDate: boolean;
}

export interface LayerSummary {
  layersTotal: number;
  layersDone: number;
  bytesTotal: number;
  bytesDone: number;
}

const KNOWN = new Set(['Pulling fs layer', 'Waiting', 'Downloading', 'Verifying Checksum', 'Download complete', 'Extracting', 'Pull complete', 'Already exists']);

export function newLayerTally(): LayerTally {
  return { layers: new Map(), upToDate: false };
}

/** Fold one pull event into the tally (mutates and returns it). */
export function foldLayerEvent(t: LayerTally, e: PullProgressEvent): LayerTally {
  const status = e.status ?? '';
  if (status.startsWith('Status: Image is up to date')) t.upToDate = true;
  if (!e.id || !KNOWN.has(status)) return t;
  const l = t.layers.get(e.id) ?? { done: false, total: 0, current: 0 };
  const total = e.progressDetail?.total;
  const current = e.progressDetail?.current;
  if (status === 'Downloading') {
    if (total && total > 0) l.total = total;
    if (current !== undefined && current >= 0) l.current = current;
  } else if (status === 'Download complete' || status === 'Verifying Checksum' || status === 'Extracting') {
    if (l.total) l.current = l.total;
  } else if (status === 'Pull complete' || status === 'Already exists') {
    l.done = true;
    if (l.total) l.current = l.total;
  }
  t.layers.set(e.id, l);
  return t;
}

export function layerSummary(t: LayerTally): LayerSummary {
  let layersDone = 0;
  let bytesTotal = 0;
  let bytesDone = 0;
  for (const l of t.layers.values()) {
    if (l.done) layersDone += 1;
    bytesTotal += l.total;
    bytesDone += Math.min(l.current, l.total || l.current);
  }
  return { layersTotal: t.layers.size, layersDone, bytesTotal, bytesDone };
}

const mb = (b: number): string => `${Math.max(1, Math.round(b / 1_000_000))} MB`;

/** "ghost:5.96-alpine: 3 of 7 layers · 61 of 142 MB" (bytes only once known). */
export function pullProgressLine(image: string, s: LayerSummary): string {
  if (s.layersTotal === 0) return `${image}: reading its manifest`;
  const bytes = s.bytesTotal > 0 ? ` · ${mb(s.bytesDone)} of ${mb(s.bytesTotal)}` : '';
  return `${image}: ${s.layersDone} of ${s.layersTotal} layers${bytes}`;
}

/** "sha256:4be1…c07a" — the short form the log shows. */
export function shortDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, '');
  return hex.length > 12 ? `sha256:${hex.slice(0, 4)}…${hex.slice(-4)}` : digest;
}
