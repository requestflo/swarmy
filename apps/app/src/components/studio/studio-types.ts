import type { inferInput, inferOutput } from '@trpc/tanstack-react-query';
import type { useTRPC } from '@/integrations/trpc';

type Studio = ReturnType<typeof useTRPC>['studio'];

export type StudioTargetView = inferOutput<Studio['targets']>[number];
export type StudioSchemaView = inferOutput<Studio['schema']>;
export type StudioTableView = StudioSchemaView['tables'][number];
export type StudioBrowseView = inferOutput<Studio['browse']>;
export type StudioRunView = inferOutput<Studio['execute']>;
export type StudioInsightsView = inferOutput<Studio['insights']>;
export type StudioHistoryRow = inferOutput<Studio['history']>[number];
export type StudioKeyRow = inferOutput<Studio['keys']>['keys'][number];
export type StudioEdit = inferInput<Studio['prepareEdit']>['edit'];
export type StudioFilter = NonNullable<inferInput<Studio['browse']>['filters']>[number];

export type StudioTab = 'data' | 'console' | 'saved' | 'insights';

/** What every studio component needs to address one database. */
export interface StudioScope {
  stack: string;
  target: StudioTargetView;
  database: string | null;
  dbIndex: number;
  /** "Unlock writes" is on (the UI's read-only default; the server still gates). */
  unlocked: boolean;
}

export const isSqlEngine = (e: string): boolean => e === 'postgres' || e === 'mysql' || e === 'mariadb';
export const isKvEngine = (e: string): boolean => e === 'redis' || e === 'valkey';

export const ENGINE_BADGE: Record<string, string> = {
  postgres: 'PG',
  mysql: 'MY',
  mariadb: 'MA',
  mongo: 'MO',
  redis: 'RE',
  valkey: 'KV',
};

/** A cell as grid text. NULL stays distinguishable from the empty string. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$oid === 'string') return `ObjectId(${o.$oid})`;
    if (typeof o.$date === 'string') return o.$date;
    if ('status' in o && Object.keys(o).length === 1) return String(o.status);
  }
  return JSON.stringify(v);
}

/** tRPC error → { message, swarmyCode } (the formatter lifts `cause.swarmyCode` onto `data`). */
export function errorInfo(e: unknown): { message: string; code: string | null } {
  const err = e as { message?: string; data?: { swarmyCode?: string } } | null;
  return { message: err?.message ?? String(e), code: err?.data?.swarmyCode ?? null };
}
