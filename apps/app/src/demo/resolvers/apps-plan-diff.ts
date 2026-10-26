import { desiredYaml, parseAppConfig, toDesired, type DesiredApp } from '@swarmy/app-config';
import type { DemoStore, DomainResolvers } from '../types';
import { apps } from './apps';
import { STOREFRONT_YAML } from './apps-config-file';

/**
 * Board 26 in demo mode: `apps.planDiff` (swarmy.yaml and the rendered spec
 * at the live release and at the plan, drawn as diffs by the drawer) and
 * `apps.plan`'s topology (the Graph's untouched boxes and their lines). The
 * texts are storefront's real swarmy.yaml with each seeded plan's change made
 * to it, so the diffs match what the plans do; the specs come from the real
 * parser and `toDesired`.
 */

interface PlanLike {
  id: string;
  repoId: string;
  environment: string;
  stack: string;
  sha: string;
  appliedAt: string | null;
  createdAt: string;
}

/** The release before production's live one still had the analytics Postgres it removed. */
const BEFORE_PROD = STOREFRONT_YAML.replace(
  '  search: { type: search, engine: meilisearch }\n',
  '  search: { type: search, engine: meilisearch }\n  analytics: { type: postgres, version: 16 }\n',
);
/** Staging's held plan drops the search index (and the variable that pointed at it). */
const STAGING_NEXT = STOREFRONT_YAML.replace('      SEARCH_URL: ${{ search.url }}\n', '').replace('  search: { type: search, engine: meilisearch }\n', '');
/** PR #142 moves sessions into their own cache. */
const PR_NEXT = STOREFRONT_YAML.replace(
  '      REDIS_URL: ${{ cache.url }}\n      SEARCH_URL',
  '      REDIS_URL: ${{ cache.url }}\n      SESSION_STORE_URL: ${{ sessions.url }}\n      SEARCH_URL',
).replace('  search: { type: search, engine: meilisearch }\n', '  sessions: { type: cache, engine: valkey, memory: 256mb }\n  search: { type: search, engine: meilisearch }\n');
const PAYMENTS = `version: 1
app: payments
services:
  api:
    build: { path: services/payments }
    replicas: two
    env:
      DATABASE_URL: \${{ ledger.url }}
resources:
  ledger-db: postgres
`;

const TEXT_AT: Record<string, { before: string | null; after: string }> = {
  'plan-storefront-prod': { before: BEFORE_PROD, after: STOREFRONT_YAML },
  'plan-storefront-staging': { before: STOREFRONT_YAML, after: STAGING_NEXT },
  'plan-storefront-pr142': { before: STOREFRONT_YAML, after: PR_NEXT },
  'plan-payments-prod': { before: null, after: PAYMENTS },
};

function spec(text: string | null, environment: string): DesiredApp | null {
  if (!text) return null;
  const r = parseAppConfig(text);
  if (!r.config) return null;
  try {
    return toDesired(r.config, environment === 'production' ? {} : { environment });
  } catch {
    return null;
  }
}

function plansOf(s: DemoStore): PlanLike[] {
  if (!s.extra['apps']) apps.seed?.(s);
  const rows = (s.extra['apps'] as { plans?: PlanLike[] } | undefined)?.plans ?? [];
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const fakeSha = (id: string): string => [...id].map((c) => (c.charCodeAt(0) % 16).toString(16)).join('').padEnd(40, '0').slice(0, 40);

const textsOf = (p: PlanLike): { before: string | null; after: string } =>
  TEXT_AT[p.id] ?? (p.repoId === 'app-storefront' ? { before: STOREFRONT_YAML, after: STOREFRONT_YAML } : { before: null, after: PAYMENTS });

export const appsPlanDiff: DomainResolvers = {
  handlers: {
    'apps.planDiff': (i, s) => {
      const { planId } = i as { planId: string };
      const plans = plansOf(s);
      const p = plans.find((x) => x.id === planId);
      if (!p) throw new Error('That plan is gone.');
      const preview = p.environment === 'preview';
      const env = preview ? 'production' : p.environment;
      const applied = plans.filter((x) => x.repoId === p.repoId && x.environment === env && x.appliedAt);
      const found = preview ? applied[0] : applied.find((x) => x.id !== p.id && x.createdAt < p.createdAt);
      const t = textsOf(p);
      // The seed keeps one plan per environment: the release a seeded plan replaces is made up here.
      const base = found
        ? { planId: found.id, sha: found.sha, environment: env, appliedAt: found.appliedAt, relation: found.id === applied[0]?.id ? 'live' : 'before' }
        : t.before
          ? { planId: `${p.id}~base`, sha: fakeSha(p.id), environment: env, appliedAt: new Date(Date.now() - 26 * 3600_000).toISOString(), relation: p.appliedAt ? 'before' : 'live' }
          : null;
      const before = base ? t.before : null;
      return {
        planId: p.id,
        sha: p.sha,
        environment: p.environment,
        path: p.repoId === 'app-storefront' ? 'swarmy.yaml' : 'services/payments/swarmy.yaml',
        base,
        file: { before, after: t.after },
        fileError: null,
        spec: preview ? null : { before: desiredYaml(spec(before, p.environment)), after: desiredYaml(spec(t.after, p.environment)) },
      };
    },

    // Comes after `apps` in the registry: the same plan, with the app it leaves behind.
    'apps.plan': (i, s) => {
      const row = apps.handlers!['apps.plan']!(i, s) as PlanLike & Record<string, unknown>;
      const d = spec(textsOf(row).after, row.environment === 'preview' ? 'production' : row.environment);
      const names = new Set((d?.resources ?? []).map((r) => r.name));
      return {
        ...row,
        topology: d
          ? {
              routes: d.routes.map((r) => ({ host: r.host, path: r.path, service: r.service })),
              services: d.services.map((x) => ({ name: x.name, uses: x.dependsOn.filter((n) => names.has(n)) })),
              resources: d.resources.map((r) => ({ name: r.name, type: r.type })),
            }
          : null,
      };
    },
  },
};
