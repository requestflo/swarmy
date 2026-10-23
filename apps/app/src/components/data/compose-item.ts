import type { DataItem } from './estate-data';

/** A compose engine's badge: mysql → MY, clickhouse → CH, valkey → KV. */
export function engineBadge(engine: string): string {
  const e = engine.toLowerCase();
  if (e.includes('postgres')) return 'PG';
  if (e.includes('mysql') || e.includes('mariadb')) return 'MY';
  if (e.includes('clickhouse')) return 'CH';
  if (e.includes('valkey') || e.includes('redis')) return 'KV';
  if (e.includes('mongo')) return 'MG';
  return e.slice(0, 2).toUpperCase() || 'DB';
}

/** A database the app runs from its own compose file (studio.targets), not managed by swarmy. */
export function composeItem(app: string, t: { name: string; engine: string; image: string | null; running: boolean }): DataItem {
  return {
    key: `compose:${app}/${t.name}`,
    app,
    kind: 'Compose',
    name: t.name,
    badge: engineBadge(t.engine),
    meta: `${t.engine} · from compose`,
    say: 'Runs from the app’s own compose file, not managed by swarmy. Open it in Studio.',
    tech: t.image ?? t.engine,
    tone: t.running ? 'ok' : 'idle',
    word: t.running ? 'Online' : 'Idle',
    risk: 0,
  };
}
