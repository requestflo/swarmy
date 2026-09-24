import { stacks } from './apps.repo';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import {
  buildInventory,
  isSystemStack,
  SYSTEM_STACK_LABEL,
  STACK_LABEL,
  SWARMY_OVERLAY_NETWORK,
  UNGROUPED,
  type InvService,
} from '@swarmy/core';
import {
  composeToModels,
  composeToStack,
  ComposeStackError,
  modelToServiceSpec,
  type ComposeFile,
  type StackPlan,
  type TranslationWarning,
} from '@swarmy/core/compose';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { enforceAdmission } from './admission-gate';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { augmentSpecsForStack } from './otel-injection';
import { stackTelemetryEnabled } from './observability.service';
import { augmentSpecsForErrors, releaseFor, specsRequestErrors } from './errors/injection';
import { ensureProject } from './errors/projects';
import { recordDeployRelease, stackErrorsEnabled } from './errors/errors.service';
import { DEPLOY_SAFETY_LABEL, DEPLOY_STRATEGY_LABEL, recordRelease } from './releases.service';
import { INGRESS_ROUTES_LABEL, readRoutes } from './ingress-routes';
import { carryManagedAttachments } from './attachment-carry';
import { carrySecretVars } from '@swarmy/core';
import { overlayOptionsFor } from './platform-networks';
import { carryLinks, stackPeers } from './stack-links.service';
import { stackEndpoints, type StackEndpoints } from './service-endpoints';
import { kickDomainChecks, registerDeployRoutes } from './domain-verify.service';

/**
 * Swarm state lives in Docker, not the DB. The Stack model is now config-only
 * (name + composeSource + ingress/telemetry flags); a stack's live status and
 * service membership are derived from the in-memory hub inventory, grouped by
 * the Docker stack-namespace label (`com.docker.stack.namespace`), whose value
 * is the swarmy stack name.
 */

/** Live services that belong to a stack, by its Docker stack-namespace label. */
function liveStackServices(ctx: OrgContext, stackName: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stackName);
}

/** Synthesize a stack-level status from its live services' statuses. */
function stackStatus(svcs: InvService[]): string {
  if (svcs.length === 0) return 'empty';
  if (svcs.some((s) => s.status === 'failing')) return 'failing';
  if (svcs.some((s) => s.status === 'deploying')) return 'deploying';
  if (svcs.some((s) => s.status === 'degraded' || s.status === 'stopped')) return 'degraded';
  return 'running';
}

/**
 * `swarmy-system` is a managed platform stack (observability, ingress,
 * storage, …), not a user app stack — reject any mutation attempt on it with
 * a clear error rather than letting it silently redeploy/remove platform
 * plumbing.
 */
function guardNotSystemStack(ctx: OrgContext, name: string): void {
  // By name (swarmy-system) OR by label: the controller's own `swarmy` stack
  // carries `swarmy.system=true` — removing or redeploying it would take the
  // control plane down from its own dashboard.
  const labelled = liveStackServices(ctx, name).some((s) => s.labels[SYSTEM_STACK_LABEL] === 'true');
  if (isSystemStack(name) || labelled) {
    throw commandRejected(`"${name}" is a managed platform stack and can't be modified`);
  }
}

/** Stamp the swarmy-managed + stack-namespace labels so live inventory groups it. */
function withStackLabels(spec: ServiceSpec, stackName: string): ServiceSpec {
  return {
    ...spec,
    labels: { ...(spec.labels ?? {}), 'swarmy.managed': 'true', [STACK_LABEL]: stackName },
  };
}

export interface StackSummary {
  id: string;
  name: string;
  serviceCount: number;
  status: string;
  updatedAt: string;
}

export interface StackDetail extends StackSummary {
  composeSource: string;
  services: { id: string; name: string; image: string }[];
  createdAt: string;
}

/** `swarmy.ingress` — the service-summary "has a route" flag, carried with the routes. */
const INGRESS_ENABLED_LABEL = 'swarmy.ingress';
const NETWORK_ENSURE_TIMEOUT_MS = 30_000;
/** Network removal retries (agent side, ~20s) while removed tasks drain. */
const STACK_NETWORK_REMOVE_TIMEOUT_MS = 60_000;

/** Parse compose YAML into a plain object; malformed YAML is a 400, not a 500. */
function parseComposeDoc(source: string): ComposeFile {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    throw commandRejected(
      `compose file is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw commandRejected('compose file must be a YAML mapping with a `services:` key');
  }
  return doc as ComposeFile;
}

/**
 * Compose YAML → SHORT-named specs through the canonical `@swarmy/core/compose`
 * translator (volumes, healthcheck, labels, secrets, configs, resources,
 * placement, restart — everything the builder round-trips). Used by callers
 * that apply their OWN naming (PR previews → `<previewStack>_<short>`). The
 * stack deploy path uses {@link planComposeStack}, which namespaces too.
 */
export function composeShortSpecs(source: string): {
  specs: ServiceSpec[];
  warnings: TranslationWarning[];
} {
  const doc = parseComposeDoc(source);
  try {
    const { models, warnings } = composeToModels(doc);
    return { specs: models.map((m) => modelToServiceSpec(m) as ServiceSpec), warnings };
  } catch (e) {
    throw commandRejected(`invalid compose file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Compose YAML → the stack-namespaced plan (`docker stack deploy` naming). */
export function planComposeStack(
  source: string,
  stack: string,
  legacyVolumes?: Record<string, Record<string, string>>,
): StackPlan {
  const doc = parseComposeDoc(source);
  try {
    return composeToStack(doc, stack, { legacyVolumes });
  } catch (e) {
    if (e instanceof ComposeStackError) throw commandRejected(e.message);
    throw e;
  }
}

/**
 * Legacy migration (pre stack-namespacing): compose deploys used to name each
 * swarm service by its BARE compose key (`web`). Those services still carry
 * `com.docker.stack.namespace=<stack>`. They are REPLACED by `<stack>_<short>`:
 * the prefixed service is deployed first and the legacy one removed after —
 * except a legacy service whose PUBLISHED port the new spec also publishes,
 * which must go first (swarm refuses two services on one ingress port; a brief
 * gap is the price). Data: a legacy anonymous volume held nothing durable (it
 * was already lost on every reschedule); a legacy NAMED volume keeps being
 * mounted under its existing name (`legacyVolumes`) so no data is orphaned.
 *
 * A second legacy shape gets the same treatment: early blueprint deploys used
 * compose keys that repeated the stack name (`wp-wordpress`), so the swarm
 * service came out DOUBLE-prefixed (`wp_wp-wordpress`). Now that blueprint keys
 * are stack-agnostic (`wordpress` → `wp_wordpress`), a redeploy of that stack
 * replaces `<stack>_<stack>-<short>` exactly like a bare-named `<short>`.
 */
export interface LegacyMigration {
  /** Legacy (bare- or double-prefix-named) services of this stack the compose now replaces. */
  legacy: SwarmServiceInfo[];
  /** Legacy service name → the compose short key it is replaced by. */
  shortOf: Record<string, string>;
  /** short → target → existing volume name (named-volume mounts only). */
  legacyVolumes: Record<string, Record<string, string>>;
  /** Legacy services whose mounts the inventory doesn't report (old agent). */
  unknownMounts: string[];
}

/** PURE — the compose short a legacy swarm service name maps to, if any. */
export function legacyShortOf(stack: string, name: string, shorts: string[]): string | undefined {
  if (shorts.includes(name)) return name;
  const doublePrefix = `${stack}_${stack}-`;
  if (name.startsWith(doublePrefix)) {
    const short = name.slice(doublePrefix.length);
    if (shorts.includes(short)) return short;
  }
  return undefined;
}

/** PURE — find the legacy services a compose deploy of `stack` replaces. */
export function findLegacyServices(
  live: SwarmServiceInfo[],
  stack: string,
  shorts: string[],
): LegacyMigration {
  const legacy: SwarmServiceInfo[] = [];
  const shortOf: LegacyMigration['shortOf'] = {};
  for (const s of live) {
    if (s.labels[STACK_LABEL] !== stack) continue;
    const short = legacyShortOf(stack, s.name, shorts);
    if (short === undefined || s.name === `${stack}_${short}`) continue;
    legacy.push(s);
    shortOf[s.name] = short;
  }
  const legacyVolumes: LegacyMigration['legacyVolumes'] = {};
  const unknownMounts: string[] = [];
  for (const svc of legacy) {
    if (!svc.mounts) {
      unknownMounts.push(svc.name);
      continue;
    }
    const byTarget = legacyMountsByTarget(svc.mounts);
    if (Object.keys(byTarget).length) legacyVolumes[shortOf[svc.name]!] = byTarget;
  }
  return { legacy, shortOf, legacyVolumes, unknownMounts };
}

/** Named-volume mounts → target → source (anonymous + bind mounts skipped). */
export function legacyMountsByTarget(
  mounts: Array<{ type?: string; source?: string; target: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mounts) {
    if ((m.type ?? 'volume') === 'volume' && m.source) out[m.target] = m.source;
  }
  return out;
}

/** PURE — split legacy removals: before deploy (published-port clash) vs after. */
export function splitLegacyRemovals(
  legacy: SwarmServiceInfo[],
  specs: ServiceSpec[],
): { before: string[]; after: string[] } {
  const published = new Set<string>();
  for (const spec of specs) {
    for (const p of spec.ports ?? []) {
      if (p.published != null) published.add(`${p.protocol ?? 'tcp'}/${p.published}`);
    }
  }
  const before: string[] = [];
  const after: string[] = [];
  for (const svc of legacy) {
    const clash = svc.ports.some(
      (p) => p.published != null && published.has(`${p.protocol}/${p.published}`),
    );
    (clash ? before : after).push(svc.name);
  }
  return { before, after };
}

/**
 * PURE — a compose (re)deploy replaces a service's whole label set, which used
 * to wipe the ingress route stamped by `ingress.addDomain`. Carry the live
 * route labels (from the same-named service, else the legacy bare-named one
 * being migrated) onto the new spec when the compose doesn't set its own, and
 * keep the service on the edge overlay the route needs.
 */
export function carryIngressRoutes(
  spec: ServiceSpec,
  source: Pick<SwarmServiceInfo, 'labels' | 'networks'> | undefined,
): ServiceSpec {
  if (!source || spec.labels?.[INGRESS_ROUTES_LABEL]) return spec;
  const routes = source.labels[INGRESS_ROUTES_LABEL];
  if (!routes || readRoutes(source.labels).length === 0) return spec;
  const labels: Record<string, string> = { ...(spec.labels ?? {}), [INGRESS_ROUTES_LABEL]: routes };
  const enabled = source.labels[INGRESS_ENABLED_LABEL];
  if (enabled) labels[INGRESS_ENABLED_LABEL] = enabled;
  const onEdge = source.networks.some((n) => n.name === SWARMY_OVERLAY_NETWORK);
  const networks =
    onEdge && !(spec.networks ?? []).includes(SWARMY_OVERLAY_NETWORK)
      ? [...(spec.networks ?? []), SWARMY_OVERLAY_NETWORK]
      : spec.networks;
  return { ...spec, labels, ...(networks ? { networks } : {}) };
}

/** Named-volume mounts of a legacy service read from a raw `service.inspect`. */
function mountsFromInspect(
  inspect: unknown,
): Array<{ type?: string; source?: string; target: string }> {
  const cs = (
    inspect as { Spec?: { TaskTemplate?: { ContainerSpec?: { Mounts?: unknown[] } } } } | null
  )?.Spec?.TaskTemplate?.ContainerSpec;
  const out: Array<{ type?: string; source?: string; target: string }> = [];
  for (const m of cs?.Mounts ?? []) {
    const o = m as { Type?: string; Source?: string; Target?: string };
    if (o?.Target) out.push({ type: o.Type, source: o.Source, target: o.Target });
  }
  return out;
}

export async function listStacks(ctx: OrgContext): Promise<StackSummary[]> {
  // Config rows (name + flags). Live status is LEFT-JOINed from Docker truth.
  const dbRows = await stacks(ctx, ctx.activeOrgId).findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const byStack = new Map<string, InvService[]>();
  for (const s of buildInventory(services, containers).services) {
    if (s.stack === UNGROUPED) continue;
    const list = byStack.get(s.stack) ?? [];
    list.push(s);
    byStack.set(s.stack, list);
  }

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const out: StackSummary[] = [];
  // DB-config stacks first (a config row with no live services shows empty).
  for (const r of dbRows) {
    seen.add(r.name);
    const svcs = byStack.get(r.name) ?? [];
    out.push({ id: r.id, name: r.name, serviceCount: svcs.length, status: stackStatus(svcs), updatedAt: now });
  }
  // Label-only stacks (live services grouped under a stack with no DB row).
  for (const [name, svcs] of byStack) {
    if (seen.has(name)) continue;
    out.push({ id: name, name, serviceCount: svcs.length, status: stackStatus(svcs), updatedAt: now });
  }
  return out;
}

export async function getStack(ctx: OrgContext, id: string): Promise<StackDetail> {
  // composeSource is config (kept on the Stack row); membership/status is live.
  const row = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true, composeSource: true },
  });
  if (!row) throw notFound('stack', id);
  const svcs = liveStackServices(ctx, row.name);
  const now = new Date().toISOString();
  return {
    id: row.id,
    name: row.name,
    serviceCount: svcs.length,
    status: stackStatus(svcs),
    updatedAt: now,
    composeSource: row.composeSource,
    services: svcs.map((s) => ({ id: s.id, name: s.name, image: s.image })),
    createdAt: now,
  };
}

export interface DeployFromComposeResult {
  id: string;
  deploymentId: string;
  releaseId: string | null;
  /** Final swarm service names (`<stack>_<short>`), in compose order. */
  services: string[];
  /** Translator warnings (unsupported keys, undeclared volumes, legacy reuse …). */
  warnings: TranslationWarning[];
  /** Legacy bare-named services replaced (and removed) by this deploy. */
  migrated: string[];
}

export async function deployFromCompose(
  ctx: OrgContext,
  input: {
    name: string;
    composeSource: string;
    override?: boolean;
    /** `automation` (git-apps GitOps loop): warns pass, only a `block` refuses. */
    admissionMode?: 'interactive' | 'automation';
  },
): Promise<DeployFromComposeResult> {
  guardNotSystemStack(ctx, input.name);
  const services = parseComposeDoc(input.composeSource).services;
  const shorts = services && typeof services === 'object' ? Object.keys(services) : [];

  // Legacy (bare-named) services of this stack the prefixed ones replace. Their
  // named volumes keep being mounted under the same name (never orphaned).
  const liveRaw = ctx.hub.liveInventory(ctx.activeOrgId).services;
  const migration = findLegacyServices(liveRaw, input.name, shorts);
  if (migration.unknownMounts.length) {
    // Old agent: no mounts in the inventory — read them from a live inspect.
    const node = await resolveManagerNode(ctx);
    for (const name of migration.unknownMounts) {
      const raw = await ctx.hub
        .dispatch<{ inspect?: unknown }>(node.id, 'service.inspect', { service: name })
        .catch(() => null);
      const byTarget = legacyMountsByTarget(mountsFromInspect(raw?.inspect));
      if (Object.keys(byTarget).length) migration.legacyVolumes[migration.shortOf[name]!] = byTarget;
    }
  }

  const plan = planComposeStack(input.composeSource, input.name, migration.legacyVolumes);
  const liveByName = new Map(liveRaw.map((s) => [s.name, s]));
  // "Connect apps" pairings are stack-level Docker truth (`swarmy.links` on
  // its services): every (re)deployed or newly added service keeps them.
  const peers = stackPeers(liveStackServices(ctx, input.name));
  const specs = plan.specs.map((spec, i) => {
    const short = plan.services[i]!.short;
    const source =
      liveByName.get(spec.name) ?? migration.legacy.find((l) => migration.shortOf[l.name] === short);
    // A redeploy rebuilds each spec from compose: carry what swarmy wired onto
    // the LIVE service since — ingress routes (+ edge network), managed-data
    // attachments (DATABASE_URL & co + their private overlay + secret), and
    // app links — or the deploy silently unwires the app.
    const routed = carryIngressRoutes(spec as ServiceSpec, source);
    // …and the secret variables set on it (Docker secrets, never values).
    const attached = carrySecretVars(carryManagedAttachments(routed, source), source);
    return carryLinks(attached, { orgId: ctx.activeOrgId, stack: input.name, peers });
  });

  // D1: every stack deploy runs the admission pipeline first. Violations refuse
  // the deploy unless explicitly overridden; overriding a `block` violation
  // needs an admin, and every override is audited.
  await enforceAdmission(
    ctx,
    {
      kind: 'stack.deploy',
      orgId: ctx.activeOrgId,
      stackName: input.name,
      specs,
      override: input.override,
    },
    { targetType: 'stack', targetId: input.name, ...(input.admissionMode ? { mode: input.admissionMode } : {}) },
  );

  const node = await resolveManagerNode(ctx);

  // The stack's overlays (`<stack>_default` + declared networks) must exist
  // before any service attaches — same `network.ensure` as managed data.
  try {
    for (const net of plan.networks) {
      // MTU sized for the WireGuard mesh when the org runs one (compose
      // `driver_opts` win) — applied at create time only.
      const options = net.driver === 'overlay' ? await overlayOptionsFor(ctx, { extra: net.options }) : net.options;
      await ctx.hub.dispatch(
        node.id,
        'network.ensure',
        {
          name: net.name,
          driver: net.driver,
          attachable: net.attachable,
          labels: net.labels,
          ...(options ? { options } : {}),
        },
        { timeoutMs: NETWORK_ENSURE_TIMEOUT_MS },
      );
    }
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Persist only the stack CONFIG (name + composeSource); status/membership are
  // read back live from Docker. No Service/Deployment rows are written.
  const stack = await stacks(ctx, ctx.activeOrgId).upsert({
    where: { orgId_name: { orgId: ctx.activeOrgId, name: input.name } },
    create: {
      orgId: ctx.activeOrgId,
      name: input.name,
      composeSource: input.composeSource,
    },
    update: { composeSource: input.composeSource },
    select: { id: true, name: true },
  });

  // D1: `swarmy.deploy.*` labels are stack-level Docker-truth config. A deploy
  // replaces each service's label set, so carry the stack's current safety +
  // strategy labels forward onto every new spec (they survive redeploys and
  // newly added services inherit them).
  const liveStack = liveStackServices(ctx, stack.name);
  const deployLabels: Record<string, string> = {};
  for (const key of [DEPLOY_SAFETY_LABEL, DEPLOY_STRATEGY_LABEL]) {
    const value = liveStack.map((s) => s.labels[key]).find((v): v is string => !!v);
    if (value) deployLabels[key] = value;
  }

  // Error tracking: a `swarmy.errors.enabled` label in the compose (swarmy.yaml
  // `errors: true`, a template) or on the live stack binds SENTRY_DSN.
  const errorsOn = specsRequestErrors(specs) || stackErrorsEnabled(ctx, stack.name);
  const errorsDsn = errorsOn ? (await ensureProject(ctx, stack.name).catch(() => null))?.dsn || null : null;
  const finalSpecs = augmentSpecsForErrors(
    augmentSpecsForStack(specs, {
      telemetryEnabled: stackTelemetryEnabled(ctx, stack.name),
      orgId: ctx.activeOrgId,
      stack: stack.name,
    }),
    { enabled: errorsOn, dsn: errorsDsn },
  ).map((spec) => {
    const labelled = withStackLabels(spec, stack.name);
    return { ...labelled, labels: { ...deployLabels, ...labelled.labels } };
  });

  // Legacy cut-over: port-clashing legacy services go first (swarm refuses a
  // second service on the same published port); the rest only AFTER the
  // prefixed replacements are deployed.
  const removals = splitLegacyRemovals(migration.legacy, finalSpecs);
  const removeLegacy = async (names: string[]) => {
    for (const service of names) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service });
    }
  };

  // The domain gate: a host this compose declares on `swarmy.ingress.routes`
  // that no live route serves yet enters DNS verification BEFORE the spec
  // lands — same as `ingress.addDomain` — so Caddy never orders a certificate
  // for a name whose DNS doesn't point at us.
  const gatedHosts = await registerDeployRoutes(ctx, finalSpecs);

  // Non-persisted deploy correlation id — keeps the API shape without a DB row.
  const deploymentId = randomUUID();
  try {
    await removeLegacy(removals.before);
    for (const spec of finalSpecs) {
      await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
    }
    await removeLegacy(removals.after);
  } catch (e) {
    throw mapDispatchError(e);
  }

  // D1: snapshot the deploy as a Release row (history + the health-gate watch).
  const release = await recordRelease(ctx, {
    stackName: stack.name,
    composeSource: input.composeSource,
    specs: finalSpecs,
    deployLabels,
  }).catch(() => null);

  kickDomainChecks(ctx, gatedHosts);
  if (errorsOn) {
    // The deploy's git sha becomes the error-tracking release ("introduced in").
    const version = finalSpecs.map(releaseFor).find((v): v is string => !!v);
    if (version) {
      void recordDeployRelease(ctx, { stack: stack.name, version, swarmyReleaseId: release?.id }).catch(() => undefined);
    }
  }
  const migrated = migration.legacy.map((s) => s.name);
  await writeAudit(ctx, {
    action: 'stack.deploy',
    targetType: 'stack',
    targetId: stack.id,
    metadata: {
      stackName: stack.name,
      services: finalSpecs.map((s) => s.name),
      releaseId: release?.id ?? null,
      ...(migrated.length ? { migratedLegacyServices: migrated } : {}),
    },
  });

  return {
    id: stack.id,
    deploymentId,
    releaseId: release?.id ?? null,
    services: finalSpecs.map((s) => s.name),
    warnings: plan.warnings,
    migrated,
  };
}

export interface AddServiceToStackInput {
  /** Target stack name = the Docker stack-namespace the new service is stamped into. */
  stack: string;
  name: string;
  image: string;
  ports?: { target: number; published?: number; protocol?: 'tcp' | 'udp' }[];
  env?: Record<string, string>;
  replicas?: number;
  /** Override admission-policy violations (audited; block-level needs admin). */
  override?: boolean;
}

/**
 * Contextual deploy: drop ONE app straight into an existing stack. Builds a
 * minimal `ServiceSpec`, runs it through the stack's telemetry injection (a
 * no-op when the stack isn't opted in), stamps the swarmy-managed +
 * stack-namespace labels so live inventory groups it under <stack>, and
 * dispatches `service.deploy` — reusing the exact spec/label/deploy path as
 * `deployFromCompose`. No Service/Deployment DB rows are written (Docker truth).
 */
export async function addServiceToStack(
  ctx: OrgContext,
  input: AddServiceToStackInput,
): Promise<{ id: string; deploymentId: string }> {
  guardNotSystemStack(ctx, input.stack);
  const node = await resolveManagerNode(ctx);

  const baseSpec: ServiceSpec = {
    name: input.name,
    image: input.image,
    mode: { replicated: { replicas: input.replicas ?? 1 } },
    env: input.env && Object.keys(input.env).length ? input.env : undefined,
    ports: input.ports?.length
      ? input.ports.map((p) => ({
          target: p.target,
          published: p.published,
          protocol: p.protocol ?? ('tcp' as const),
          mode: 'ingress' as const,
        }))
      : undefined,
  };

  // Same augmentation pipeline as the compose path: telemetry first, then the
  // stack-namespace + swarmy.managed labels.
  const errorsOn = stackErrorsEnabled(ctx, input.stack);
  const errorsDsn = errorsOn ? (await ensureProject(ctx, input.stack).catch(() => null))?.dsn || null : null;
  const [spec] = augmentSpecsForErrors(
    augmentSpecsForStack([baseSpec], {
      telemetryEnabled: stackTelemetryEnabled(ctx, input.stack),
      orgId: ctx.activeOrgId,
      stack: input.stack,
    }),
    { enabled: errorsOn, dsn: errorsDsn },
  ).map((s) => withStackLabels(s, input.stack));

  // A single-app drop into a stack is a service deploy — same admission gate
  // (and override semantics) as the compose path.
  await enforceAdmission(
    ctx,
    {
      kind: 'service.deploy',
      orgId: ctx.activeOrgId,
      stackName: input.stack,
      specs: [spec],
      override: input.override,
    },
    { targetType: 'service', targetId: input.name },
  );

  const gatedHosts = await registerDeployRoutes(ctx, spec ? [spec] : []);
  const deploymentId = randomUUID();
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    throw mapDispatchError(e);
  }
  kickDomainChecks(ctx, gatedHosts);

  // Best-effort live id (inventory is eventually consistent); name is the stable
  // fallback until the new service surfaces under the stack.
  const id = liveStackServices(ctx, input.stack).find((s) => s.name === input.name)?.id ?? input.name;
  await writeAudit(ctx, {
    action: 'service.deploy',
    targetType: 'service',
    targetId: id,
    metadata: { name: input.name, image: input.image, stack: input.stack, override: input.override === true },
  });
  return { id, deploymentId };
}

export async function redeployStack(
  ctx: OrgContext,
  input: { id: string; composeSource?: string; override?: boolean },
): Promise<DeployFromComposeResult> {
  // Label-only stacks (no DB config row, e.g. swarmy-system) use their name as
  // `id` in the stacks list — guard before the (would-be) notFound lookup too.
  guardNotSystemStack(ctx, input.id);
  const stack = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
    select: { name: true, composeSource: true },
  });
  if (!stack) throw notFound('stack', input.id);
  guardNotSystemStack(ctx, stack.name);
  return deployFromCompose(ctx, {
    name: stack.name,
    composeSource: input.composeSource ?? stack.composeSource,
    override: input.override,
  });
}

export async function removeStack(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  // Label-only stacks (no DB config row, e.g. swarmy-system) use their name as
  // `id` in the stacks list — guard before the (would-be) notFound lookup too.
  guardNotSystemStack(ctx, id);
  const stack = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { id, orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  if (!stack) throw notFound('stack', id);
  guardNotSystemStack(ctx, stack.name);
  const node = await resolveManagerNode(ctx).catch(() => null);
  if (node) {
    // Service membership comes from live Docker inventory, not a DB relation.
    for (const svc of liveStackServices(ctx, stack.name)) {
      await ctx.hub.dispatch(node.id, 'service.remove', { service: svc.name }).catch(() => undefined);
    }
    // Then the stack's own overlays (`<stack>_default`, `<stack>_<net>`). The
    // agent only removes networks labelled for THIS stack + `swarmy.managed`
    // (what `network.ensure` stamped at deploy) — never external ones — and
    // retries while the removed tasks release their endpoints, so this is
    // fire-and-forget rather than holding the request open.
    void ctx.hub
      .dispatch(node.id, 'network.removeForStack', { stack: stack.name }, { timeoutMs: STACK_NETWORK_REMOVE_TIMEOUT_MS })
      .catch(() => undefined);
  }
  await stacks(ctx, ctx.activeOrgId).delete({ where: { id } });
  return { id, removed: true };
}

/**
 * Internal hostnames for a stack's services + managed resources, from live
 * inventory (see `service-endpoints.ts`). Org-scoped: only this org's services.
 */
export function stackEndpointsFor(ctx: OrgContext, stack: string): StackEndpoints {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const inv = buildInventory(services, containers).services;
  if (!inv.some((s) => s.stack === stack)) throw notFound('stack', stack);
  return stackEndpoints(stack, inv);
}
