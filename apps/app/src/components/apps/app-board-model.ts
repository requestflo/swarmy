import type { HealthEntryView, IncidentView, NodeSummary, ReleaseView } from '@swarmy/core';
import { lastGood } from '@/components/app-tabs/releases/release-label';
import { deployWords, diagnosisWords, serversWords, type DeployWords, type ServersWords } from './app-board-words';
import type { AppItem } from './use-apps';

/** The slice of `apps.list` the board reads: each git app's environments and previews. */
export interface GitAppLike {
  appName: string | null;
  environments: { environment: string; stack: string }[];
  previews: { stack: string; pr: number }[];
}

export type EnvKind = 'production' | 'staging' | 'preview' | 'other';
export interface EnvPill {
  label: string;
  kind: EnvKind;
}

export type StatusFilter = 'all' | 'attn' | 'ok' | 'idle';

export interface BoardRow {
  app: AppItem;
  /** The environment this app's stack is: production (also every non-git app), staging, preview… */
  env: string;
  pills: EnvPill[];
  /** undefined = still finding out; null = runs on no server right now. */
  servers: ServersWords | null | undefined;
  deploy: DeployWords | null | undefined;
  status: Exclude<StatusFilter, 'all'> | 'other';
  haystack: string;
  /** The inline fix for an app that needs you. */
  fix: { diagnosis: string; putBack: ReleaseView | null; incidentId: string | null } | null;
}

export interface BoardInput {
  apps: AppItem[];
  gitApps?: GitAppLike[];
  releases?: ReleaseView[];
  placement?: Map<string, NodeSummary[]>;
  incidents?: IncidentView[];
  health?: HealthEntryView[];
  now?: number;
}

const kindOf = (env: string): EnvKind =>
  env === 'production' || env === 'staging' || env === 'preview' ? env : 'other';

/** stack → { env, the production stack it belongs to } from the git apps. */
export function envIndex(gitApps: GitAppLike[]): Map<string, { env: string; home: string }> {
  const out = new Map<string, { env: string; home: string }>();
  for (const a of gitApps) {
    const home = a.environments.find((e) => e.environment === 'production')?.stack || a.appName || '';
    for (const e of a.environments) if (e.stack) out.set(e.stack, { env: e.environment, home });
    for (const p of a.previews) if (p.stack) out.set(p.stack, { env: 'preview', home });
  }
  return out;
}

/** A production row names its other environments and previews; any other row names its own. */
export function envPills(stack: string, gitApps: GitAppLike[]): EnvPill[] {
  const info = envIndex(gitApps).get(stack);
  if (info && info.env !== 'production') return [{ label: info.env, kind: kindOf(info.env) }];
  const git = gitApps.find((a) => (a.environments.find((e) => e.environment === 'production')?.stack || a.appName) === stack);
  const pills: EnvPill[] = [{ label: 'production', kind: 'production' }];
  for (const e of git?.environments ?? []) if (e.environment !== 'production') pills.push({ label: e.environment, kind: kindOf(e.environment) });
  const n = git?.previews.length ?? 0;
  if (n > 0) pills.push({ label: `${n} preview${n === 1 ? '' : 's'}`, kind: 'preview' });
  return pills;
}

/** An open incident whose title names the app or one of its parts. */
export function incidentFor(app: AppItem, incidents: IncidentView[]): IncidentView | null {
  const names = [app.name, ...app.stat.services.map((s) => s.name)].map((n) => n.toLowerCase());
  return (
    incidents.find(
      (i) => i.status === 'open' && names.some((n) => new RegExp(`(^|[^a-z0-9-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`).test(i.title.toLowerCase())),
    ) ?? null
  );
}

function statusOf(app: AppItem): BoardRow['status'] {
  if (app.words.attention) return 'attn';
  if (app.words.tone === 'ok') return 'ok';
  if (app.words.tone === 'idle') return 'idle';
  return 'other';
}

export function buildRows(input: BoardInput): BoardRow[] {
  const envs = envIndex(input.gitApps ?? []);
  return input.apps.map((app) => {
    const own = input.releases?.filter((r) => r.stackName === app.name);
    const nodes = input.placement?.get(app.name);
    const servers = input.placement ? serversWords(nodes ?? [], app.hosts.length > 0) : undefined;
    const env = envs.get(app.name)?.env ?? 'production';
    const incident = app.words.attention ? incidentFor(app, input.incidents ?? []) : null;
    const reasons = input.health?.find((h) => h.kind === 'stack' && h.name === app.name)?.reasons ?? [];
    return {
      app,
      env,
      pills: envPills(app.name, input.gitApps ?? []),
      servers,
      deploy: own ? deployWords(own, input.now) : undefined,
      status: statusOf(app),
      haystack: [app.name, ...app.hosts, ...(nodes ?? []).flatMap((n) => [n.name, n.region ?? '']), env].join(' ').toLowerCase(),
      fix: app.words.attention
        ? {
            diagnosis: diagnosisWords({ say: app.words.say, reasons, head: own?.[0], incident: incident?.title }),
            putBack: own ? (lastGood(own) ?? null) : null,
            incidentId: incident?.id ?? null,
          }
        : null,
    };
  });
}

/** What the list holds before search and filters: production only, unless grouped by environment. */
export function poolFor(rows: BoardRow[], group: 'none' | 'env'): BoardRow[] {
  return group === 'env' ? rows : rows.filter((r) => r.env === 'production');
}

export function matchesSearch(row: BoardRow, q: string): boolean {
  const t = q.trim().toLowerCase();
  return !t || row.haystack.includes(t);
}

export function statusCounts(pool: BoardRow[], q: string): Record<StatusFilter, number> {
  const hit = pool.filter((r) => matchesSearch(r, q));
  return {
    all: hit.length,
    attn: hit.filter((r) => r.status === 'attn').length,
    ok: hit.filter((r) => r.status === 'ok').length,
    idle: hit.filter((r) => r.status === 'idle').length,
  };
}

export interface RowGroup {
  key: string;
  label: string;
  hint: string;
  rows: BoardRow[];
}

const GROUPS: Record<string, [string, string]> = {
  production: ['Production', 'what visitors use'],
  staging: ['Staging', 'from the staging branch'],
  preview: ['Previews', 'one per open pull request'],
};

/** Search + status filter, then one unlabelled group, or one group per environment (production first). */
export function groupRows(rows: BoardRow[], group: 'none' | 'env', q: string, status: StatusFilter): RowGroup[] {
  const shown = poolFor(rows, group).filter((r) => matchesSearch(r, q) && (status === 'all' || r.status === status));
  if (group === 'none') return shown.length ? [{ key: 'production', label: '', hint: '', rows: shown }] : [];
  const order = ['production', 'staging', 'preview'];
  const keys = [...new Set(shown.map((r) => r.env))].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  return keys.map((k) => ({
    key: k,
    label: GROUPS[k]?.[0] ?? k.charAt(0).toUpperCase() + k.slice(1),
    hint: GROUPS[k]?.[1] ?? '',
    rows: shown.filter((r) => r.env === k),
  }));
}
