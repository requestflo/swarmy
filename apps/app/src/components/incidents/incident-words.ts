/**
 * Plain words for what automation writes. Incident and alert text carries
 * resource keys (`service:storefront_checkout`, `release:storefront`), release
 * ids (`rel-store-6`) and glossary words (replicas, canary). At Summary those
 * read as "checkout in storefront", "the storefront rollout", "1.9.0" and
 * "copies"; the raw text moves to a Controls `Tech` line.
 */

export interface WordsContext {
  /** Docker service name → app (stack), from the live inventory. */
  serviceApp: ReadonlyMap<string, string>;
  /** Known app (stack) names, for `<app>_<part>` service names. */
  apps: readonly string[];
  /** Release id → version ("rel-store-6" → "1.9.0"). */
  versions?: ReadonlyMap<string, string>;
}

/** "storefront_checkout" → { app: storefront, part: checkout }; "checkout" via the inventory. */
export function splitServiceName(name: string, ctx: WordsContext): { app: string | null; part: string } {
  const byLength = [...ctx.apps].sort((a, b) => b.length - a.length);
  for (const app of byLength) {
    if (name.startsWith(`${app}_`) && name.length > app.length + 1) return { app, part: name.slice(app.length + 1) };
  }
  return { app: ctx.serviceApp.get(name) ?? null, part: name };
}

/** A service name in words: "checkout in storefront", or just "checkout" when its app is unknown. */
export function partWords(name: string, ctx: WordsContext): string {
  const { app, part } = splitServiceName(name, ctx);
  return app && app !== part ? `${part} in ${app}` : part;
}

/** A resource / group key in words: service, release, db, node, alert:<key>. */
export function resourceWords(key: string, ctx: WordsContext): string {
  const [kind, ...rest] = key.split(':');
  const value = rest.join(':');
  if (!value) return key;
  switch (kind) {
    case 'service':
      return partWords(value, ctx);
    case 'release':
      return `the ${value} rollout`;
    case 'db':
      return `the ${value} database`;
    case 'node':
      return `server ${value}`;
    case 'backup':
      return `the ${value} backup`;
    case 'alert':
      return resourceWords(value, ctx);
    default:
      return key;
  }
}

const KEY = /\b(service|release|db|node|backup|alert):[\w.:-]+/g;

/** Rewrite one line of automation text in plain words. Idempotent on plain text. */
export function plainWords(text: string, ctx: WordsContext): string {
  const version = (id: string): string | null => ctx.versions?.get(id) ?? null;
  // "error-rate on service:x — Error rate on x is 6.2%…": the sentence after the dash says it all.
  const signalled = /^[a-z][a-z0-9-]* on (?:service|node|db|backup|release):\S+ — ([A-Z].*)$/.exec(text);
  let out = (signalled?.[1] ?? text)
    // "release rel-store-6 (1.9.0)" → "1.9.0"; "release rel-store-6" → its version.
    .replace(/\brelease (rel-[\w-]+) \(([^)]+)\)/g, '$2')
    .replace(/\brelease (rel-[\w-]+)/g, (_m, id: string) => version(id) ?? 'a new version')
    .replace(/\b(rel-[\w-]+)\b/g, (_m, id: string) => version(id) ?? 'a new version')
    // "Incident opened (release:storefront)" → "Incident opened for the storefront rollout".
    .replace(/\s*\(((?:service|release|db|node|backup|alert):[^)\s]+)\)/g, (_m, key: string) => ` for ${resourceWords(key, ctx)}`)
    // "replicas on service:checkout" → "copies of checkout in storefront".
    .replace(/\breplicas on\b/gi, (m) => (m[0] === 'R' ? 'Copies of' : 'copies of'))
    .replace(KEY, (key) => resourceWords(key, ctx))
    // "41/662 spans" → "41 of 662 requests".
    .replace(/\b(\d+)\/(\d+) spans\b/g, '$1 of $2 requests')
    .replace(/\bspans?, threshold\b/g, 'requests, limit');
  // Bare "<app>_<part>" service names.
  for (const app of ctx.apps) {
    out = out.replace(new RegExp(`\\b${escape(app)}_([\\w-]+)`, 'g'), (_m, part: string) => `${part} in ${app}`);
  }
  return out
    .replace(/\breplicas\b/g, 'copies')
    .replace(/\bReplicas\b/g, 'Copies')
    .replace(/\breplica\b/g, 'copy')
    .replace(/\bcanary\b/g, 'trial run')
    .replace(/\bCanary\b/g, 'Trial run')
    .replace(/\bfailover\b/g, 'switch-over')
    .replace(/\brolled back\b/g, 'put back')
    .replace(/\brollback\b/g, 'put-back')
    .replace(/\bnode\b/g, 'server')
    .replace(/\bNode\b/g, 'Server');
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "ghcr.io/northwind/web:1.9.0" → "1.9.0" (the version in sentences; buttons say "v1.9.0"). */
export function versionOf(images: ReadonlyArray<{ image: string }>): string | null {
  const image = images[0]?.image;
  if (!image || image.includes('@')) return null;
  const tag = image.slice(image.lastIndexOf(':') + 1);
  return tag && !tag.includes('/') ? tag : null;
}
