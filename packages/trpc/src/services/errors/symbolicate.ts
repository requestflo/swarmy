/**
 * Symbolicate an event's JavaScript frames against uploaded artifacts.
 *
 * IO goes through an {@link ArtifactSource} (ClickHouse in production, an
 * in-memory map in tests), so the matching rules — debug id first, then the
 * minified file's `sourceMappingURL`, then `<file>.map` — are testable
 * end-to-end against the real fixture bundle. Parsed maps are LRU-cached;
 * a map that fails to parse is remembered as a miss.
 */
import type { NormalizedEvent, SentryFrame } from './event';
import {
  matchArtifact,
  normalizeDebugId,
  parseSourceMap,
  resolveMapName,
  sourceMappingUrl,
  symbolicateFrame,
  type ParsedSourceMap,
} from './sourcemap';

export interface ArtifactEntry {
  release: string;
  name: string;
  debugId: string;
  kind: 'sourcemap' | 'minified' | string;
}

export interface ArtifactSource {
  /** Artifacts for the event's release plus release-less ones (`release: ''`). */
  index(release: string): Promise<ArtifactEntry[]>;
  /** Artifacts by debug id, any release. */
  byDebugIds(ids: string[]): Promise<ArtifactEntry[]>;
  /** Raw artifact content. */
  load(release: string, name: string): Promise<string | null>;
}

const JS_FILE = /\.(m|c)?js(\?.*)?$|\.jsx?(\?.*)?$/i;
const MAX_MAPS = 32;
const mapCache = new Map<string, ParsedSourceMap | null>();

function cacheGet(key: string): ParsedSourceMap | null | undefined {
  if (!mapCache.has(key)) return undefined;
  const v = mapCache.get(key)!;
  mapCache.delete(key);
  mapCache.set(key, v); // LRU touch
  return v;
}
function cacheSet(key: string, v: ParsedSourceMap | null): void {
  mapCache.set(key, v);
  while (mapCache.size > MAX_MAPS) mapCache.delete(mapCache.keys().next().value!);
}
export function clearSourceMapCache(): void {
  mapCache.clear();
}

function wantsSymbolication(f: SentryFrame): boolean {
  const file = f.abs_path || f.filename || '';
  return !!f.lineno && !!f.colno && JS_FILE.test(file) && !f.data?.symbolicated;
}

/**
 * Resolve which map artifact applies to a frame. Pure given the index +
 * (for the sourceMappingURL hop) the minified file's content.
 */
export async function mapForFrame(
  f: SentryFrame,
  entries: ArtifactEntry[],
  debugIds: Record<string, string>,
  loadMinified: (e: ArtifactEntry) => Promise<string | null>,
): Promise<ArtifactEntry | null> {
  const file = f.abs_path || f.filename || '';
  const maps = entries.filter((e) => e.kind === 'sourcemap');
  const rawId = debugIds[file] ?? debugIds[f.filename ?? ''] ?? null;
  const debugId = rawId ? normalizeDebugId(rawId) : null;
  if (debugId) {
    const hit = maps.find((m) => m.debugId === debugId);
    if (hit) return hit;
  }
  const minifiedName = matchArtifact(file, entries.filter((e) => e.kind !== 'sourcemap').map((e) => e.name));
  if (minifiedName) {
    const minified = entries.find((e) => e.name === minifiedName)!;
    const code = await loadMinified(minified);
    const url = code ? sourceMappingUrl(code) : null;
    if (url && !url.startsWith('data:')) {
      const wanted = resolveMapName(minifiedName, url);
      const byName = maps.find((m) => m.name === wanted) ?? maps.find((m) => m.name === matchArtifact(wanted, maps.map((x) => x.name)));
      if (byName) return byName;
    }
  }
  const byConvention = matchArtifact(`${file.replace(/[?#].*$/, '')}.map`, maps.map((m) => m.name));
  return byConvention ? (maps.find((m) => m.name === byConvention) ?? null) : null;
}

/**
 * Symbolicate every JS frame of every exception in place-ish (returns a new
 * exceptions array). Returns how many frames were resolved.
 */
export async function symbolicateEvent(
  event: NormalizedEvent,
  source: ArtifactSource,
  cacheScope: string,
): Promise<number> {
  const all = event.exceptions.flatMap((e) => e.stacktrace?.frames ?? []);
  if (!all.some(wantsSymbolication)) return 0;
  const ids = Object.values(event.debugIds).map(normalizeDebugId);
  const [index, byId] = await Promise.all([source.index(event.release), ids.length ? source.byDebugIds(ids) : Promise.resolve([])]);
  const entries = [...byId, ...index];
  if (!entries.length) return 0;

  const loadMinified = (e: ArtifactEntry) => source.load(e.release, e.name);
  let resolved = 0;
  for (const exc of event.exceptions) {
    const frames = exc.stacktrace?.frames;
    if (!frames) continue;
    const out: SentryFrame[] = [];
    for (const f of frames) {
      if (!wantsSymbolication(f)) {
        out.push(f);
        continue;
      }
      const entry = await mapForFrame(f, entries, event.debugIds, loadMinified);
      if (!entry) {
        out.push(f);
        continue;
      }
      const key = `${cacheScope}|${entry.release}|${entry.name}`;
      let map = cacheGet(key);
      if (map === undefined) {
        const text = await source.load(entry.release, entry.name);
        try {
          map = text ? parseSourceMap(text) : null;
        } catch {
          map = null;
        }
        cacheSet(key, map);
      }
      if (!map) {
        out.push(f);
        continue;
      }
      const s = symbolicateFrame(f, map, entry.name);
      if (s !== f) resolved += 1;
      out.push(s);
    }
    exc.stacktrace = { ...exc.stacktrace, frames: out };
  }
  return resolved;
}
