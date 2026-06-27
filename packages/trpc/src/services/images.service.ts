/**
 * Docker Hub image-name + tag autocomplete, proxied controller-side (the browser
 * can't call Hub directly: CORS + shared caching + rate-limit amortization).
 *
 * Best-effort and non-blocking — a failed/limited lookup returns `[]` so the UI
 * degrades to a plain text field. See plans/epic-stack-gui-builder.md
 * "Autocomplete sourcing".
 */

export interface ImageSuggestion {
  /** Canonical pull name, official images as bare `<name>` (no `library/`). */
  name: string;
  description: string;
  official: boolean;
  stars: number;
}

export interface TagSuggestion {
  name: string;
  /** ISO timestamp of last push, when known. */
  updatedAt?: string;
}

const SEARCH_URL = 'https://hub.docker.com/v2/search/repositories';
const SEARCH_TTL_MS = 5 * 60_000;
const TAGS_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 4_000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

const searchCache = new Map<string, CacheEntry<ImageSuggestion[]>>();
const tagsCache = new Map<string, CacheEntry<TagSuggestion[]>>();

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number): void {
  map.set(key, { value, expires: Date.now() + ttl });
  // Cheap bound: drop the oldest if the cache grows large.
  if (map.size > 500) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Split a pull name into Hub namespace/repo, defaulting official to `library`. */
function splitImageName(image: string): { namespace: string; repo: string } | null {
  // Strip any tag/digest.
  const noTag = image.split('@')[0]?.split(':')[0] ?? image;
  if (!noTag) return null;
  // Registry-qualified names (with a dot or port before the first slash) aren't Hub.
  const firstSeg = noTag.split('/')[0] ?? '';
  if (firstSeg.includes('.') || firstSeg.includes(':')) return null;
  const parts = noTag.split('/');
  if (parts.length === 1) return { namespace: 'library', repo: parts[0] ?? '' };
  return { namespace: parts[0] ?? 'library', repo: parts.slice(1).join('/') };
}

interface HubSearchResult {
  results?: Array<{
    repo_name?: string;
    short_description?: string;
    is_official?: boolean;
    star_count?: number;
  }>;
}

export async function searchImages(query: string): Promise<ImageSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const cached = getCached(searchCache, q);
  if (cached) return cached;

  const url = `${SEARCH_URL}/?query=${encodeURIComponent(q)}&page_size=10`;
  const json = (await fetchJson(url)) as HubSearchResult | null;
  if (!json?.results) return [];

  const suggestions: ImageSuggestion[] = json.results.map((r) => {
    const raw = r.repo_name ?? '';
    const official = r.is_official === true || raw.startsWith('library/');
    const name = official ? raw.replace(/^library\//, '') : raw;
    return {
      name,
      description: r.short_description ?? '',
      official,
      stars: r.star_count ?? 0,
    };
  });
  setCached(searchCache, q, suggestions, SEARCH_TTL_MS);
  return suggestions;
}

interface HubTagsResult {
  results?: Array<{ name?: string; last_updated?: string }>;
}

export async function listTags(image: string): Promise<TagSuggestion[]> {
  const parts = splitImageName(image);
  if (!parts || !parts.repo) return [];
  const key = `${parts.namespace}/${parts.repo}`;
  const cached = getCached(tagsCache, key);
  if (cached) return cached;

  const url = `https://hub.docker.com/v2/namespaces/${encodeURIComponent(parts.namespace)}/repositories/${encodeURIComponent(parts.repo)}/tags?page_size=25&ordering=-last_updated`;
  const json = (await fetchJson(url)) as HubTagsResult | null;
  if (!json?.results) return [];

  const tags: TagSuggestion[] = json.results
    .filter((t) => typeof t.name === 'string')
    .map((t) => ({ name: t.name as string, updatedAt: t.last_updated }));
  setCached(tagsCache, key, tags, TAGS_TTL_MS);
  return tags;
}
