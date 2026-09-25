/**
 * Per-app RUM settings (web analytics + session replay) — Docker truth.
 *
 * The app's settings are the `swarmy.rum` label (JSON) on EVERY live service
 * of its stack (so any one of them answers, like `swarmy.otel.enabled`); a
 * route can opt out (or in) with `rum: "off" | "on"` inside its own
 * `swarmy.ingress.routes` entry. Saving re-renders ingress so the edge picks
 * the change up — no redeploy, the app is never modified.
 */
import { buildInventory, UNGROUPED, type InvService } from '@swarmy/core';
import type { RouteRum } from '@swarmy/ingress';
import {
  RUM_SETTINGS_LABEL,
  RumSettingsSchema,
  readRumSettings,
  serializeRumSettings,
  signRumToken,
  type RumRouteMode,
  type RumSettings,
} from '@swarmy/rum';
import type { OrgContext } from '../../context';
import { resolveManagerNode } from '../dispatch.service';
import { writeAudit } from '../audit.service';
import { mapDispatchError, notFound } from '../../errors';
import { INGRESS_ROUTES_LABEL } from '../ingress-routes';
import { rumStoreStatus } from './rum-store';

export function rumSecret(): string {
  const s = process.env.SWARMY_SECRET_KEY;
  if (!s) throw new Error('SWARMY_SECRET_KEY is not set — required for RUM app tokens');
  return s;
}

function stackServices(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>, stack: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stack);
}

/** The app's settings, read off its live services (first labelled one wins). */
export function appRumSettings(ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>, stack: string): RumSettings {
  const labelled = stackServices(ctx, stack).find((s) => s.labels[RUM_SETTINGS_LABEL]);
  return readRumSettings(labelled?.labels);
}

/**
 * The render fragment for one route (pure given its inputs). `override` is
 * the route's own `rum` toggle. Absent result ⇒ no injection.
 */
export function rumRouteFor(input: {
  orgId: string;
  stack: string;
  settings: RumSettings;
  override?: RumRouteMode;
  upstream: string;
  secret: string;
}): RouteRum | undefined {
  const { settings: s } = input;
  const on = input.override === 'on' || (input.override !== 'off' && s.enabled);
  if (!on || !input.stack || input.stack === UNGROUPED) return undefined;
  const identified = s.mode === 'identified';
  const replay = identified ? s.replaySampleRate : 0;
  return {
    upstream: input.upstream,
    token: signRumToken(input.secret, { o: input.orgId, a: input.stack, m: identified ? 'i' : 'a', s: replay, r: s.retentionDays }),
    mode: s.mode,
    replaySampleRate: replay,
    consent: s.consent,
    maskAllText: s.maskAllText,
    blockSelectors: s.blockSelectors,
    csp: s.csp,
  };
}

/**
 * Ingress hook: stack → settings for every stack that has routes, computed
 * once per render. Returns a resolver for (stack, override).
 */
export function rumRouteResolver(
  ctx: Pick<OrgContext, 'hub' | 'activeOrgId'>,
  upstream: string,
): (stack: string, override?: RumRouteMode) => RouteRum | undefined {
  const cache = new Map<string, RumSettings>();
  let secret: string | null = null;
  return (stack, override) => {
    if (!cache.has(stack)) cache.set(stack, appRumSettings(ctx, stack));
    const settings = cache.get(stack)!;
    if (!settings.enabled && override !== 'on') return undefined;
    try {
      secret ??= rumSecret();
    } catch {
      return undefined; // no secret ⇒ no signed token ⇒ no injection (never an unsigned tag)
    }
    return rumRouteFor({ orgId: ctx.activeOrgId, stack, settings, override, upstream, secret });
  };
}

export interface RumRouteView {
  service: string;
  host: string;
  path: string;
  /** The route's own toggle (absent = follows the app). */
  override: RumRouteMode | null;
  /** Effective: will the edge inject on this route? */
  injected: boolean;
}

export interface RumSettingsView {
  stack: string;
  settings: RumSettings;
  routes: RumRouteView[];
  stores: { analytics: boolean; replay: boolean };
}

interface RawRoute {
  host?: unknown;
  path?: unknown;
  rum?: unknown;
}

function rawRoutes(labels: Record<string, string>): RawRoute[] {
  try {
    const v = JSON.parse(labels[INGRESS_ROUTES_LABEL] ?? '[]');
    return Array.isArray(v) ? (v as RawRoute[]) : [];
  } catch {
    return [];
  }
}

/**
 * `written`: labels this request just wrote, per service name. The live
 * inventory lags a label write by a snapshot tick, so a view read straight
 * after a save showed the OLD settings (and the page flipped back). Overlaying
 * what was written makes the answer exactly what was saved.
 */
export async function getRumSettings(
  ctx: OrgContext,
  stack: string,
  written: Record<string, Record<string, string>> = {},
): Promise<RumSettingsView> {
  const services = stackServices(ctx, stack).map((s) =>
    written[s.name] ? { ...s, labels: { ...s.labels, ...written[s.name] } } : s,
  );
  if (services.length === 0) throw notFound('stack', stack);
  const settings = readRumSettings(services.find((s) => s.labels[RUM_SETTINGS_LABEL])?.labels);
  const routes: RumRouteView[] = [];
  for (const s of services) {
    for (const r of rawRoutes(s.labels)) {
      if (typeof r.host !== 'string') continue;
      const override = r.rum === 'on' || r.rum === 'off' ? (r.rum as RumRouteMode) : null;
      routes.push({
        service: s.name,
        host: r.host,
        path: typeof r.path === 'string' ? r.path : '/',
        override,
        injected: override === 'on' || (override !== 'off' && settings.enabled),
      });
    }
  }
  routes.sort((a, b) => (a.host + a.path).localeCompare(b.host + b.path));
  return { stack, settings, routes, stores: await rumStoreStatus(ctx) };
}

/** Called after a label change so the edge re-renders (injected to avoid an import cycle). */
export type IngressRefresh = (ctx: OrgContext) => Promise<unknown>;

export async function setRumSettings(
  ctx: OrgContext,
  input: { stack: string; settings: RumSettings },
  refresh: IngressRefresh,
): Promise<RumSettingsView> {
  const settings = RumSettingsSchema.parse(input.settings);
  const services = stackServices(ctx, input.stack);
  if (services.length === 0) throw notFound('stack', input.stack);
  const value = serializeRumSettings(settings);
  const node = await resolveManagerNode(ctx);
  try {
    for (const svc of services) {
      if (svc.labels[RUM_SETTINGS_LABEL] === value) continue;
      await ctx.hub.dispatch(node.id, 'service.updateLabels', {
        service: svc.name,
        add: { [RUM_SETTINGS_LABEL]: value },
        removeKeys: [],
      });
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'rum.settings.update',
    targetType: 'stack',
    targetId: input.stack,
    metadata: {
      enabled: settings.enabled,
      mode: settings.mode,
      replaySampleRate: settings.replaySampleRate,
      consent: settings.consent,
      retentionDays: settings.retentionDays,
      maskAllText: settings.maskAllText,
    },
  });
  await refresh(ctx).catch(() => undefined);
  // Answer with what was saved, not the not-yet-refreshed inventory.
  return getRumSettings(ctx, input.stack, Object.fromEntries(services.map((svc) => [svc.name, { [RUM_SETTINGS_LABEL]: value }])));
}

/** Flip one route's own toggle (`null` = follow the app). Only the `rum` key of that entry changes. */
export async function setRumRoute(
  ctx: OrgContext,
  input: { stack: string; service: string; host: string; path: string; override: RumRouteMode | null },
  refresh: IngressRefresh,
): Promise<RumSettingsView> {
  const svc = stackServices(ctx, input.stack).find((s) => s.name === input.service);
  if (!svc) throw notFound('service', input.service);
  const routes = rawRoutes(svc.labels) as Record<string, unknown>[];
  const idx = routes.findIndex(
    (r) => r.host === input.host && ((typeof r.path === 'string' ? r.path : '/') || '/') === (input.path || '/'),
  );
  if (idx < 0) throw notFound('route', `${input.host}${input.path}`);
  const next = { ...routes[idx] };
  if (input.override) next.rum = input.override;
  else delete next.rum;
  routes[idx] = next;
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: svc.name,
      add: { [INGRESS_ROUTES_LABEL]: JSON.stringify(routes) },
      removeKeys: [],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'rum.route.update',
    targetType: 'service',
    targetId: svc.name,
    metadata: { host: input.host, path: input.path, override: input.override },
  });
  await refresh(ctx).catch(() => undefined);
  return getRumSettings(ctx, input.stack, { [svc.name]: { [INGRESS_ROUTES_LABEL]: JSON.stringify(routes) } });
}
