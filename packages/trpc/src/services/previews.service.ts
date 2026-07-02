import {
  buildInventory,
  STACK_LABEL,
  UNGROUPED,
  type InvService,
  type PreviewSettingsView,
  type PreviewStatusView,
  type PreviewView,
} from '@swarmy/core';
import type { SecretListResult, ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveLiveService } from './live-resolve';
import { composeToSpecs } from './stack.service';
import { systemContext, triggerBuildForRepo } from './cicd.service';
import { applyNow, getConfig } from './ingress.service';
import { INGRESS_ROUTES_LABEL, serializeRoutes } from './ingress-routes';

/**
 * PR preview environments (slice D4).
 *
 * A preview is an ephemeral Docker stack `pr<N>-<repo-short>` deployed from the
 * repo's linked stack compose with the PR branch's freshly-built image swapped
 * in. Pure **Docker-truth** (docker-native-storage): every service in the stack
 * carries the `swarmy.preview.*` labels below — the previews list, TTL expiry
 * and teardown are all derived from the live hub inventory. The ONLY DB write
 * is the repo's INPUT config (`GitRepo.previewsJson`: enabled/baseDomain/
 * ttlHours/teardownOnClose) + the Build rows the reused cicd build path records.
 *
 * Lifecycle: PR opened/synchronize (webhook) → build branch via the cicd build
 * path → deploy the preview stack (+ ingress route `pr-<N>.<baseDomain>`);
 * PR closed → teardown; TTL expiry → `preview-reconcile` worker teardown.
 *
 * apps/api (webhook receiver + reconcile worker) consumes `handlePrEventForRepo`
 * / `teardownExpiredPreviews` / `parsePrWebhookEvent` — designed for export from
 * the package root (see ORCHESTRATOR TODO in apps/api/src/webhooks.ts).
 */

// ── Label scheme (Docker-truth; JSON-free, one value per key) ─────────────────

export const PREVIEW_REPO_LABEL = 'swarmy.preview.repo';
export const PREVIEW_PR_LABEL = 'swarmy.preview.pr';
export const PREVIEW_BRANCH_LABEL = 'swarmy.preview.branch';
export const PREVIEW_URL_LABEL = 'swarmy.preview.url';
export const PREVIEW_CREATED_LABEL = 'swarmy.preview.createdAt';
export const PREVIEW_TTL_LABEL = 'swarmy.preview.ttlHours';
/** Stamped on Docker SECRETS scoped to one preview stack so teardown finds them. */
export const PREVIEW_SECRET_STACK_LABEL = 'swarmy.preview.stack';

const MANAGED_LABEL = 'swarmy.managed';
const INGRESS_ENABLED_LABEL = 'swarmy.ingress';
/**
 * Previews attach to the shared attachable `swarmy` overlay (the one the caddy
 * ingress controller lives on — see ingress-controller.ts DEFAULT_NETWORK): the
 * proxy can dial `pr…_web:port`, and preview members reach each other.
 */
export const PREVIEW_NETWORK = 'swarmy';
const DISPATCH_TIMEOUT_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;

/** Defaults for a repo that never saved settings. */
export const DEFAULT_PREVIEW_SETTINGS: PreviewSettingsView = {
  enabled: false,
  baseDomain: '',
  ttlHours: 72,
  teardownOnClose: true,
};

// ── Pure codec (unit-tested in previews.service.test.ts) ──────────────────────

/** The decoded `swarmy.preview.*` label set of one preview stack. */
export interface PreviewMeta {
  repo: string;
  pr: number;
  branch: string;
  url: string | null;
  /** ISO of the last deploy; null when the label is missing/garbled. */
  createdAt: string | null;
  /** TTL hours from `createdAt`; 0 = never expires. */
  ttlHours: number;
}

/** Repo short-name from its git URL: `https://…/northwind/shop.git` → `shop`. */
export function repoShort(url: string): string {
  const last = url
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .pop();
  const slug = (last ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/g, '');
  return slug || 'app';
}

/** Preview stack namespace: `pr<N>-<repo-short>` (Docker + DNS safe, ≤ 63). */
export function previewStackName(pr: number, repoUrl: string): string {
  return `pr${pr}-${repoShort(repoUrl)}`.slice(0, 63);
}

/** Host a preview publishes at: `pr-<N>.<baseDomain>`. */
export function previewHost(pr: number, baseDomain: string): string {
  return `pr-${pr}.${baseDomain}`;
}

/**
 * Stable pseudo-PR number (90000–99999) for a manual branch preview, so branch
 * previews ride the exact same stack-name/label/teardown machinery as real PRs.
 * FNV-1a over the branch name — the same branch always maps to the same number.
 */
export function branchPreviewNumber(branch: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < branch.length; i++) {
    h ^= branch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 90_000 + ((h >>> 0) % 10_000);
}

/** Encode a preview's meta as the `swarmy.preview.*` label set. */
export function previewLabels(meta: PreviewMeta): Record<string, string> {
  return {
    [PREVIEW_REPO_LABEL]: meta.repo,
    [PREVIEW_PR_LABEL]: String(meta.pr),
    [PREVIEW_BRANCH_LABEL]: meta.branch,
    [PREVIEW_CREATED_LABEL]: meta.createdAt ?? new Date().toISOString(),
    [PREVIEW_TTL_LABEL]: String(meta.ttlHours),
    ...(meta.url ? { [PREVIEW_URL_LABEL]: meta.url } : {}),
  };
}

/**
 * Decode `swarmy.preview.*` labels back to a {@link PreviewMeta}. Tolerant: a
 * service without a parseable PR number is NOT a preview (null); a garbled
 * createdAt/ttl degrades to "no TTL" rather than an instant teardown.
 */
export function parsePreviewMeta(labels: Record<string, string>): PreviewMeta | null {
  const pr = Number.parseInt(labels[PREVIEW_PR_LABEL] ?? '', 10);
  if (!Number.isSafeInteger(pr) || pr < 1) return null;
  const createdRaw = labels[PREVIEW_CREATED_LABEL];
  const createdMs = createdRaw ? Date.parse(createdRaw) : Number.NaN;
  const ttl = Number.parseInt(labels[PREVIEW_TTL_LABEL] ?? '', 10);
  return {
    repo: labels[PREVIEW_REPO_LABEL] ?? '',
    pr,
    branch: labels[PREVIEW_BRANCH_LABEL] ?? '',
    url: labels[PREVIEW_URL_LABEL] || null,
    createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
    ttlHours: Number.isSafeInteger(ttl) && ttl > 0 ? ttl : 0,
  };
}

/** When a preview expires (createdAt + ttlHours), or null for "never". */
export function previewExpiresAt(meta: PreviewMeta): Date | null {
  if (meta.ttlHours <= 0 || !meta.createdAt) return null;
  return new Date(Date.parse(meta.createdAt) + meta.ttlHours * HOUR_MS);
}

/** TTL selection: which preview stacks are past their expiry at `now`. */
export function selectExpiredPreviews(
  previews: { stack: string; meta: PreviewMeta }[],
  now: Date,
): string[] {
  const out: string[] = [];
  for (const p of previews) {
    const expires = previewExpiresAt(p.meta);
    if (expires && expires.getTime() <= now.getTime()) out.push(p.stack);
  }
  return out;
}

/** Parse `GitRepo.previewsJson` (repo INPUT config) with safe defaults. */
export function parsePreviewSettings(json: unknown): PreviewSettingsView {
  if (typeof json !== 'object' || json === null) return { ...DEFAULT_PREVIEW_SETTINGS };
  const v = json as Record<string, unknown>;
  const ttl = typeof v.ttlHours === 'number' ? Math.trunc(v.ttlHours) : Number.NaN;
  return {
    enabled: v.enabled === true,
    baseDomain: typeof v.baseDomain === 'string' ? v.baseDomain.trim().toLowerCase() : '',
    ttlHours: Number.isSafeInteger(ttl) && ttl >= 0 && ttl <= 720 ? ttl : DEFAULT_PREVIEW_SETTINGS.ttlHours,
    teardownOnClose: v.teardownOnClose !== false,
  };
}

// ── Pure spec transform (compose specs → preview stack specs) ─────────────────

export interface BuildPreviewSpecsOpts {
  stackName: string;
  meta: PreviewMeta;
  /** Built image for the PR branch — swapped onto the target service. */
  image: string;
  /** Compose short-name of the service the repo builds (null = first spec). */
  targetShort: string | null;
  /** Ingress host (`pr-142.preview.example.com`) or null for no route. */
  host: string | null;
}

/**
 * Whole-token replace of compose short-names inside env values so cross-service
 * references (`DB_HOST=db`) keep resolving once every service is renamed to
 * `<previewStack>_<short>` (ServiceSpec carries no network aliases).
 */
export function rewritePreviewEnv(
  env: Record<string, string>,
  shortNames: string[],
  stackName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const escaped = shortNames
    .filter((n) => n.length > 0)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const [key, value] of Object.entries(env)) {
    let next = value;
    for (let i = 0; i < escaped.length; i++) {
      const re = new RegExp(`(^|[^a-zA-Z0-9_-])(${escaped[i]})(?![a-zA-Z0-9_-])`, 'g');
      next = next.replace(re, (_m, pre: string) => `${pre}${stackName}_${shortNames[i]}`);
    }
    out[key] = next;
  }
  return out;
}

/**
 * Turn the linked stack's compose specs into the preview stack's specs:
 *  - names become `<previewStack>_<short>` (swarm DNS keeps them addressable),
 *  - the target service's image is swapped for the PR build,
 *  - replicas clamp to 1 and port PUBLISHING is dropped entirely (a preview is
 *    private-by-default: it must never fight prod — or another preview — over
 *    host ports, and an ingress-mode port without `published` would get a
 *    RANDOM public port). The `pr-<N>` route is the only front door,
 *  - every service attaches to the shared `swarmy` overlay (proxy-reachable,
 *    members inter-reachable) instead of compose networks that don't exist in
 *    the preview's namespace,
 *  - env values are rewritten so cross-service short-name references resolve,
 *  - every service carries the stack-namespace + `swarmy.preview.*` labels,
 *  - the target (web) service gets the `pr-<N>.<host>` ingress route label.
 */
export function buildPreviewSpecs(specs: ServiceSpec[], opts: BuildPreviewSpecsOpts): ServiceSpec[] {
  if (specs.length === 0) return [];
  const shorts = specs.map((s) => s.name);
  const targetIdx = Math.max(
    0,
    specs.findIndex((s) => s.name === (opts.targetShort ?? specs[0]!.name)),
  );
  const baseLabels = {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: opts.stackName,
    ...previewLabels(opts.meta),
  };

  return specs.map((spec, i) => {
    const isTarget = i === targetIdx;
    const routePort = spec.ports?.[0]?.target ?? 80;
    const env = rewritePreviewEnv(
      {
        ...(spec.env ?? {}),
        PREVIEW: 'true',
        PREVIEW_PR: String(opts.meta.pr),
        PREVIEW_BRANCH: opts.meta.branch,
        ...(opts.meta.url ? { PREVIEW_URL: opts.meta.url } : {}),
      },
      shorts,
      opts.stackName,
    );
    const labels: Record<string, string> = { ...(spec.labels ?? {}), ...baseLabels };
    if (isTarget && opts.host) {
      labels[INGRESS_ROUTES_LABEL] = serializeRoutes([{ host: opts.host, port: routePort, tls: 'auto' }]);
      labels[INGRESS_ENABLED_LABEL] = 'true';
    }
    return {
      ...spec,
      name: `${opts.stackName}_${spec.name}`,
      image: isTarget ? opts.image : spec.image,
      mode: { replicated: { replicas: 1 } },
      env,
      labels,
      networks: [PREVIEW_NETWORK],
      // Overlay-only: the ingress route (or nothing) is the front door.
      ports: undefined,
    };
  });
}

// ── Inventory scan (Docker-truth reads) ───────────────────────────────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

/** Group the org's live services into preview stacks (label-driven). */
function scanPreviewStacks(ctx: OrgContext): Map<string, InvService[]> {
  const byStack = new Map<string, InvService[]>();
  for (const s of liveOrgServices(ctx)) {
    if (s.stack === UNGROUPED) continue;
    if (!parsePreviewMeta(s.labels)) continue;
    const list = byStack.get(s.stack) ?? [];
    list.push(s);
    byStack.set(s.stack, list);
  }
  return byStack;
}

function previewStatus(members: InvService[]): PreviewStatusView {
  if (members.some((s) => s.status === 'deploying')) return 'deploying';
  if (members.every((s) => s.status === 'stopped' || s.status === 'idle')) return 'stopped';
  if (members.some((s) => s.status === 'degraded' || s.status === 'stopped')) return 'degraded';
  return 'running';
}

function toPreviewView(stack: string, members: InvService[]): PreviewView | null {
  let meta: PreviewMeta | null = null;
  for (const m of members) {
    meta = parsePreviewMeta(m.labels);
    if (meta) break;
  }
  if (!meta) return null;
  return {
    stack,
    repo: meta.repo,
    pr: meta.pr,
    branch: meta.branch,
    url: meta.url,
    createdAt: meta.createdAt,
    ttlHours: meta.ttlHours,
    expiresAt: previewExpiresAt(meta)?.toISOString() ?? null,
    serviceCount: members.length,
    runningServices: members.filter((s) => s.status === 'running').length,
    status: previewStatus(members),
  };
}

/** Every live preview environment in the org (inventory scan; no DB). */
export function listPreviews(ctx: OrgContext): PreviewView[] {
  const out: PreviewView[] = [];
  for (const [stack, members] of scanPreviewStacks(ctx)) {
    const view = toPreviewView(stack, members);
    if (view) out.push(view);
  }
  return out.sort((a, b) => b.pr - a.pr || a.stack.localeCompare(b.stack));
}

// ── Settings (GitRepo.previewsJson — the one DB write of this slice) ──────────

export async function getPreviewSettings(ctx: OrgContext, repoId: string): Promise<PreviewSettingsView> {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: repoId, orgId: ctx.activeOrgId },
    select: { previewsJson: true },
  });
  if (!repo) throw notFound('repo', repoId);
  return parsePreviewSettings(repo.previewsJson);
}

export async function setPreviewSettings(
  ctx: OrgContext,
  input: { repoId: string; enabled: boolean; baseDomain: string; ttlHours: number; teardownOnClose: boolean },
): Promise<PreviewSettingsView> {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: input.repoId, orgId: ctx.activeOrgId },
    select: { id: true },
  });
  if (!repo) throw notFound('repo', input.repoId);
  const settings: PreviewSettingsView = {
    enabled: input.enabled,
    baseDomain: input.baseDomain,
    ttlHours: input.ttlHours,
    teardownOnClose: input.teardownOnClose,
  };
  await ctx.db.gitRepo.update({ where: { id: repo.id }, data: { previewsJson: settings as unknown as object } });
  await writeAudit(ctx, {
    action: 'previews.setSettings',
    targetType: 'gitRepo',
    targetId: repo.id,
    actorType: ctx.user ? 'user' : 'system',
    metadata: { ...settings },
  });
  return settings;
}

// ── PR event handling (webhook + manual) ──────────────────────────────────────

export type PrAction = 'opened' | 'synchronize' | 'closed';

export interface PrEvent {
  repoId: string;
  action: PrAction;
  prNumber: number;
  branch: string;
  commit?: string | null;
}

export interface PrEventResult {
  action: 'deployed' | 'torn-down' | 'skipped';
  stack?: string;
  url?: string | null;
  reason?: string;
}

/**
 * The webhook → preview state machine. opened/synchronize: build the PR branch
 * via the cicd build path, then (re)deploy the preview stack; closed: teardown
 * (when `teardownOnClose`). Everything is audited; the deploy refreshes
 * `createdAt`, so the TTL counts from the LAST push, not the first.
 */
export async function handlePrEvent(ctx: OrgContext, event: PrEvent): Promise<PrEventResult> {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: event.repoId, orgId: ctx.activeOrgId },
  });
  if (!repo) throw notFound('repo', event.repoId);
  const settings = parsePreviewSettings(repo.previewsJson);
  if (!settings.enabled) return { action: 'skipped', reason: 'previews are disabled for this repo' };

  const stackName = previewStackName(event.prNumber, repo.url);

  if (event.action === 'closed') {
    if (!settings.teardownOnClose) return { action: 'skipped', reason: 'teardownOnClose is off' };
    if (scanPreviewStacks(ctx).get(stackName) === undefined) {
      return { action: 'skipped', reason: 'no live preview for this PR' };
    }
    await teardownPreview(ctx, stackName, { reason: 'pr-closed' });
    return { action: 'torn-down', stack: stackName };
  }

  // opened / synchronize → build the branch via the existing cicd build path
  // (builder-node dispatch, registry push, Build row, live logs — all reused).
  const build = await triggerBuildForRepo(
    { db: ctx.db, hub: ctx.hub, auth: ctx.auth },
    { repoId: repo.id, orgId: ctx.activeOrgId, ref: event.branch, commit: event.commit ?? null },
  );
  if (!build.image) throw commandRejected('preview build produced no image reference');

  const { specs, targetShort } = await previewSpecsSource(ctx, repo, build.image);
  const host = settings.baseDomain ? previewHost(event.prNumber, settings.baseDomain) : null;
  const meta: PreviewMeta = {
    repo: repoShort(repo.url),
    pr: event.prNumber,
    branch: event.branch,
    url: host ? `https://${host}` : null,
    createdAt: new Date().toISOString(),
    ttlHours: settings.ttlHours,
  };
  const finalSpecs = buildPreviewSpecs(specs, {
    stackName,
    meta,
    image: build.image,
    targetShort,
    host,
  });

  const node = await resolveManagerNode(ctx);
  try {
    // Idempotent: the shared attachable overlay previews (and the ingress
    // proxy) live on — a fresh estate may not have it yet.
    await ctx.hub.dispatch(node.id, 'network.ensure', {
      name: PREVIEW_NETWORK,
      driver: 'overlay',
      attachable: true,
      labels: { [MANAGED_LABEL]: 'true' },
    });
    for (const spec of finalSpecs) {
      await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Surface the pr-<N> host now (best-effort — the route label is already truth).
  if (host) await reapplyIngress(ctx);

  await writeAudit(ctx, {
    action: 'previews.deploy',
    targetType: 'previewStack',
    targetId: stackName,
    actorType: ctx.user ? 'user' : 'system',
    metadata: {
      pr: event.prNumber,
      branch: event.branch,
      image: build.image,
      url: meta.url,
      services: finalSpecs.map((s) => s.name),
    },
  });
  return { action: 'deployed', stack: stackName, url: meta.url };
}

/**
 * SYSTEM-principal wrapper for the apps/api webhook receiver (mirrors
 * `triggerBuildForRepo`'s deps shape). Designed for export from the package root.
 */
export async function handlePrEventForRepo(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  input: PrEvent & { orgId: string },
): Promise<PrEventResult> {
  return handlePrEvent(systemContext(deps, input.orgId), input);
}

/** Manual "preview this branch" — same machinery, pseudo-PR number. */
export async function createManualPreview(
  ctx: OrgContext,
  input: { repoId: string; branch: string },
): Promise<PrEventResult> {
  return handlePrEvent(ctx, {
    repoId: input.repoId,
    action: 'opened',
    prNumber: branchPreviewNumber(input.branch),
    branch: input.branch,
  });
}

/** Compose specs for the preview: the linked stack's compose, else one service. */
async function previewSpecsSource(
  ctx: OrgContext,
  repo: { serviceId: string | null },
  image: string,
): Promise<{ specs: ServiceSpec[]; targetShort: string | null }> {
  const linked = repo.serviceId ? resolveLiveService(ctx, repo.serviceId) : undefined;
  if (linked && linked.stack !== UNGROUPED) {
    const row = await ctx.db.stack.findFirst({
      where: { orgId: ctx.activeOrgId, name: linked.stack },
      select: { composeSource: true },
    });
    if (row?.composeSource) {
      const specs = composeToSpecs(row.composeSource);
      if (specs.length > 0) {
        const short = linked.name.startsWith(`${linked.stack}_`)
          ? linked.name.slice(linked.stack.length + 1)
          : linked.name;
        return { specs, targetShort: specs.some((s) => s.name === short) ? short : null };
      }
    }
  }
  // No linked stack compose: a single-service preview of the built image.
  const port = linked?.ports[0]?.target ?? 80;
  return {
    specs: [
      {
        name: 'app',
        image,
        mode: { replicated: { replicas: 1 } },
        ports: [{ target: port, protocol: 'tcp', mode: 'ingress' }],
      },
    ],
    targetShort: 'app',
  };
}

// ── Teardown (close / TTL / manual) ───────────────────────────────────────────

export interface TeardownResult {
  stack: string;
  removedServices: number;
  removedSecrets: number;
}

/**
 * Remove a preview stack: every service (which drops its route labels with it),
 * any Docker secret stamped `swarmy.preview.stack=<stack>`, then re-render the
 * org ingress so the `pr-<N>` host stops resolving. Audited.
 */
export async function teardownPreview(
  ctx: OrgContext,
  stackName: string,
  opts?: { reason?: string },
): Promise<TeardownResult> {
  const members = scanPreviewStacks(ctx).get(stackName) ?? [];
  const node = await resolveManagerNode(ctx);
  const hadRoutes = members.some((s) => s.labels[INGRESS_ROUTES_LABEL]);

  try {
    for (const svc of members) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name }, { timeoutMs: DISPATCH_TIMEOUT_MS });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Preview-scoped Docker secrets (best-effort: teardown must not fail on them).
  let removedSecrets = 0;
  try {
    const res = await ctx.hub.dispatch<SecretListResult>(node.id, 'secret.list', {}, { timeoutMs: DISPATCH_TIMEOUT_MS });
    for (const sec of res.secrets ?? []) {
      if (sec.labels?.[PREVIEW_SECRET_STACK_LABEL] !== stackName) continue;
      await ctx.hub
        .dispatch(node.id, 'secret.remove', { name: sec.name }, { timeoutMs: DISPATCH_TIMEOUT_MS })
        .catch(() => undefined);
      removedSecrets++;
    }
  } catch {
    // secret listing is advisory — the services are already gone
  }

  if (hadRoutes) await reapplyIngress(ctx);

  await writeAudit(ctx, {
    action: 'previews.teardown',
    targetType: 'previewStack',
    targetId: stackName,
    actorType: ctx.user ? 'user' : 'system',
    metadata: { reason: opts?.reason ?? 'manual', removedServices: members.length, removedSecrets },
  });
  return { stack: stackName, removedServices: members.length, removedSecrets };
}

/** Dashboard "Destroy" — 404s when the stack isn't a live preview. */
export async function destroyPreview(ctx: OrgContext, input: { stack: string }): Promise<TeardownResult> {
  const members = scanPreviewStacks(ctx).get(input.stack);
  if (!members || members.length === 0) throw notFound('preview', input.stack);
  return teardownPreview(ctx, input.stack, { reason: 'destroyed from dashboard' });
}

/**
 * TTL sweep (hourly `preview-reconcile` worker): teardown every preview past
 * `createdAt + ttlHours`. Per-stack failures are swallowed — the next tick retries.
 */
export async function teardownExpiredPreviews(
  ctx: OrgContext,
): Promise<{ checked: number; tornDown: string[] }> {
  const stacks = scanPreviewStacks(ctx);
  const withMeta: { stack: string; meta: PreviewMeta }[] = [];
  for (const [stack, members] of stacks) {
    for (const m of members) {
      const meta = parsePreviewMeta(m.labels);
      if (meta) {
        withMeta.push({ stack, meta });
        break;
      }
    }
  }
  const expired = selectExpiredPreviews(withMeta, new Date());
  const tornDown: string[] = [];
  for (const stack of expired) {
    const ok = await teardownPreview(ctx, stack, { reason: 'ttl-expired' })
      .then(() => true)
      .catch(() => false);
    if (ok) tornDown.push(stack);
  }
  return { checked: withMeta.length, tornDown };
}

// ── Provider webhook parsing (pure; consumed by apps/api/src/webhooks.ts) ─────

export interface PrWebhookEvent {
  action: PrAction;
  prNumber: number;
  branch: string;
  commit: string | null;
}

const GH_OPENED = new Set(['opened', 'reopened', 'ready_for_review']);
const GL_OPENED = new Set(['open', 'reopen']);
const GL_CLOSED = new Set(['close', 'merge']);

/**
 * Detect + normalize a GitHub `pull_request` / GitLab `Merge Request Hook`
 * payload. Returns null for anything else (pushes, pings, label churn …) so the
 * webhook receiver can fall through to its existing push handling.
 */
export function parsePrWebhookEvent(
  provider: 'github' | 'gitlab',
  eventHeader: string | null | undefined,
  body: unknown,
): PrWebhookEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  if (provider === 'github') {
    if (eventHeader !== 'pull_request') return null;
    const prObj = (b.pull_request ?? {}) as Record<string, unknown>;
    const head = (prObj.head ?? {}) as Record<string, unknown>;
    const number = typeof prObj.number === 'number' ? prObj.number : typeof b.number === 'number' ? b.number : Number.NaN;
    const branch = typeof head.ref === 'string' ? head.ref : '';
    if (!Number.isSafeInteger(number) || number < 1 || !branch) return null;
    const raw = typeof b.action === 'string' ? b.action : '';
    const action: PrAction | null = GH_OPENED.has(raw)
      ? 'opened'
      : raw === 'synchronize'
        ? 'synchronize'
        : raw === 'closed'
          ? 'closed'
          : null;
    if (!action) return null;
    return { action, prNumber: number, branch, commit: typeof head.sha === 'string' ? head.sha : null };
  }

  // gitlab — MR hooks mirror the push-hook token verification already applied.
  if (b.object_kind !== 'merge_request' && eventHeader !== 'Merge Request Hook') return null;
  const attrs = (b.object_attributes ?? {}) as Record<string, unknown>;
  const iid = typeof attrs.iid === 'number' ? attrs.iid : Number.NaN;
  const branch = typeof attrs.source_branch === 'string' ? attrs.source_branch : '';
  if (!Number.isSafeInteger(iid) || iid < 1 || !branch) return null;
  const raw = typeof attrs.action === 'string' ? attrs.action : '';
  const action: PrAction | null = GL_OPENED.has(raw)
    ? 'opened'
    : raw === 'update'
      ? 'synchronize'
      : GL_CLOSED.has(raw)
        ? 'closed'
        : null;
  if (!action) return null;
  const lastCommit = (attrs.last_commit ?? {}) as Record<string, unknown>;
  return { action, prNumber: iid, branch, commit: typeof lastCommit.id === 'string' ? lastCommit.id : null };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Re-render + dispatch the org ingress (best-effort; labels stay the truth). */
async function reapplyIngress(ctx: OrgContext): Promise<void> {
  try {
    const cfg = await getConfig(ctx);
    if (cfg.enabled && cfg.driver !== 'none') await applyNow(ctx).catch(() => undefined);
  } catch {
    // ingress not configured — the route label alone is fine
  }
}
