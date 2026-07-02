import {
  buildInventory,
  type ExposedPortView,
  type ExposureKind,
  type ExposureOverview,
  type ExposureRowView,
  type ExposureRulesView,
  type ExposureViolationView,
  type ManagedDataKind,
  type SetExposureRulesInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { readRoutes } from './ingress-routes';

/**
 * Exposure (slice E3) — the public/private/managed audit of every service.
 *
 * The audit is pure Docker-truth: one pass over the live inventory classifies
 * each service by its published ports (world-reachable on every node), its
 * `swarmy.ingress.routes` label (domains behind the ingress) and its managed-data
 * labels (`swarmy.db.* / cache.* / search.* / vector.*`). Nothing is persisted —
 * the only DB row this slice owns is the one-per-org `ExposureConfig` carrying
 * the rule toggles + the enforce flag ("Block violating deploys").
 *
 * The exposure-audit worker mirrors the pure helpers below (a worker cannot
 * subpath-import an internal @swarmy/trpc module — same constraint the
 * queue/cache reconcile workers document). This file holds the unit-tested
 * canonical copies. v1 never auto-remediates: violations raise alert events and
 * land on the Exposure page, but swarmy never removes a port by itself.
 */

// ── Managed-data detection (labels owned by A2/A3/F4/F5 — read-only here) ─────

const MANAGED_PREFIXES: ReadonlyArray<[ManagedDataKind, string]> = [
  ['db', 'swarmy.db.'],
  ['cache', 'swarmy.cache.'],
  ['search', 'swarmy.search.'],
  ['vector', 'swarmy.vector.'],
];

/** Which managed-data family a label set marks, or null for a plain app. */
export function managedKindOf(labels: Record<string, string>): ManagedDataKind | null {
  for (const [kind, prefix] of MANAGED_PREFIXES) {
    for (const key of Object.keys(labels)) {
      if (key.startsWith(prefix)) return kind;
    }
  }
  return null;
}

// ── Pure: the audit classifier ────────────────────────────────────────────────

/** The slice of a live service the classifier needs. */
export interface ClassifiableService {
  id: string;
  name: string;
  stack: string;
  labels: Record<string, string>;
  ports: Array<{ target: number; published?: number; protocol: string }>;
}

function portDetail(p: ExposedPortView): string {
  const mode = p.mode ? ` (${p.mode})` : '';
  return `:${p.published} → ${p.target}/${p.protocol}${mode} published`;
}

/**
 * Classify one service. Verdict precedence: a published port makes it
 * `public-port` (even for managed data — that is exactly the violation case),
 * then ingress domains make it `public-domain`, then managed labels make it
 * `internal-managed`, else `private`.
 */
export function classifyService(svc: ClassifiableService): ExposureRowView {
  const publishedPorts: ExposedPortView[] = svc.ports
    .filter((p) => typeof p.published === 'number' && p.published > 0)
    .map((p) => ({
      target: p.target,
      published: p.published as number,
      protocol: p.protocol === 'udp' ? 'udp' : 'tcp',
      mode: null,
    }));
  const domains = readRoutes(svc.labels).map((r) => r.host);
  const managedKind = managedKindOf(svc.labels);

  const exposure: ExposureKind =
    publishedPorts.length > 0
      ? 'public-port'
      : domains.length > 0
        ? 'public-domain'
        : managedKind
          ? 'internal-managed'
          : 'private';

  const details: string[] = [
    ...publishedPorts.map(portDetail),
    ...readRoutes(svc.labels).map((r) => `${r.host} → :${r.port} (tls ${r.tls})`),
  ];
  if (details.length === 0) {
    details.push(managedKind ? `managed ${managedKind} — private networking only` : 'no public surface');
  }

  return {
    serviceId: svc.id,
    serviceName: svc.name,
    stack: svc.stack,
    exposure,
    managedKind,
    publishedPorts,
    domains,
    details,
  };
}

// ── Pure: rules codec + defaults ──────────────────────────────────────────────

/** Seeded on first `rules` read; matches the manifest's default set. */
export const DEFAULT_EXPOSURE_RULES: ExposureRulesView = {
  noPublicPortsOnManagedData: true,
  noPublicUdp: true,
  warnOnNewPublishedPorts: true,
  enforce: false,
};

/** Parse `ExposureConfig.rulesJson` (+ the row's enforce flag) with defaults. */
export function parseExposureRules(rulesJson: unknown, enforce: boolean): ExposureRulesView {
  const o = (typeof rulesJson === 'object' && rulesJson !== null ? rulesJson : {}) as Record<
    string,
    unknown
  >;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  return {
    noPublicPortsOnManagedData: bool(
      o.noPublicPortsOnManagedData,
      DEFAULT_EXPOSURE_RULES.noPublicPortsOnManagedData,
    ),
    noPublicUdp: bool(o.noPublicUdp, DEFAULT_EXPOSURE_RULES.noPublicUdp),
    warnOnNewPublishedPorts: bool(
      o.warnOnNewPublishedPorts,
      DEFAULT_EXPOSURE_RULES.warnOnNewPublishedPorts,
    ),
    enforce,
  };
}

// ── Pure: current-estate rule evaluation (stateless rules only) ───────────────

/**
 * Violations of the stateless block-rules against the CURRENT estate.
 * (`warnOnNewPublishedPorts` is diff-based — it lives in the admission
 * evaluator and the exposure-audit worker, not here.)
 */
export function evaluateEstateRules(
  rows: ExposureRowView[],
  rules: ExposureRulesView,
): ExposureViolationView[] {
  const out: ExposureViolationView[] = [];
  for (const row of rows) {
    if (row.publishedPorts.length === 0) continue;
    if (rules.noPublicPortsOnManagedData && row.managedKind) {
      const ports = row.publishedPorts.map((p) => p.published).join(', ');
      out.push({
        rule: 'exposure/no-public-ports-on-managed-data',
        severity: 'block',
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        stack: row.stack,
        message: `Managed ${row.managedKind} service ${row.serviceName} publishes port${row.publishedPorts.length === 1 ? '' : 's'} ${ports} to the world.`,
        fixHint: `Remove published port ${ports} from ${row.serviceName} — apps reach it over private networking (attach injects the connection URL).`,
      });
    }
    if (rules.noPublicUdp) {
      for (const p of row.publishedPorts) {
        if (p.protocol !== 'udp') continue;
        out.push({
          rule: 'exposure/no-public-udp',
          severity: 'block',
          serviceId: row.serviceId,
          serviceName: row.serviceName,
          stack: row.stack,
          message: `${row.serviceName} publishes UDP port ${p.published} — UDP exposure needs explicit approval.`,
          fixHint: `Remove the UDP publish on :${p.published}, or redeploy with an explicit override to approve it.`,
        });
      }
    }
  }
  return out;
}

/** Group counts for the overview hero. */
export function countExposure(rows: ExposureRowView[]): ExposureOverview['counts'] {
  let pub = 0;
  let priv = 0;
  let managed = 0;
  for (const r of rows) {
    if (r.exposure === 'public-port' || r.exposure === 'public-domain') pub += 1;
    else if (r.exposure === 'internal-managed') managed += 1;
    else priv += 1;
  }
  return { public: pub, private: priv, managed };
}

// ── Live audit + config procs ─────────────────────────────────────────────────

/** Classify every live service in the org (Docker-truth, no DB). */
export function auditExposure(ctx: OrgContext): ExposureRowView[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers)
    .services.map((s) => classifyService(s))
    .sort((a, b) => `${a.stack}/${a.serviceName}`.localeCompare(`${b.stack}/${b.serviceName}`));
}

/** The audit table + counts — the Exposure page's main query. */
export async function overview(ctx: OrgContext): Promise<ExposureOverview> {
  const rows = auditExposure(ctx);
  return { rows, counts: countExposure(rows), auditedAt: new Date().toISOString() };
}

/** The org's rules; seeds the default `ExposureConfig` row on first read. */
export async function getRules(ctx: OrgContext): Promise<ExposureRulesView> {
  const row = await ctx.db.exposureConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: {
      orgId: ctx.activeOrgId,
      rulesJson: {
        noPublicPortsOnManagedData: DEFAULT_EXPOSURE_RULES.noPublicPortsOnManagedData,
        noPublicUdp: DEFAULT_EXPOSURE_RULES.noPublicUdp,
        warnOnNewPublishedPorts: DEFAULT_EXPOSURE_RULES.warnOnNewPublishedPorts,
      },
      enforce: DEFAULT_EXPOSURE_RULES.enforce,
    },
    update: {},
    select: { rulesJson: true, enforce: true },
  });
  return parseExposureRules(row.rulesJson, row.enforce);
}

/** Update rule toggles / the enforce switch (partial; audited). */
export async function setRules(
  ctx: OrgContext,
  input: SetExposureRulesInput,
): Promise<ExposureRulesView> {
  const current = await getRules(ctx);
  const next: ExposureRulesView = {
    noPublicPortsOnManagedData:
      input.noPublicPortsOnManagedData ?? current.noPublicPortsOnManagedData,
    noPublicUdp: input.noPublicUdp ?? current.noPublicUdp,
    warnOnNewPublishedPorts: input.warnOnNewPublishedPorts ?? current.warnOnNewPublishedPorts,
    enforce: input.enforce ?? current.enforce,
  };
  await ctx.db.exposureConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      rulesJson: {
        noPublicPortsOnManagedData: next.noPublicPortsOnManagedData,
        noPublicUdp: next.noPublicUdp,
        warnOnNewPublishedPorts: next.warnOnNewPublishedPorts,
      },
      enforce: next.enforce,
    },
  });
  await writeAudit(ctx, {
    action: 'exposure.rules.set',
    targetType: 'exposureConfig',
    targetId: ctx.activeOrgId,
    metadata: { ...next },
  });
  return next;
}

/** Current audit × current rules → the violations feed. */
export async function listViolations(ctx: OrgContext): Promise<ExposureViolationView[]> {
  const rules = await getRules(ctx);
  return evaluateEstateRules(auditExposure(ctx), rules);
}
