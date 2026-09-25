/**
 * The controller's egress overlay to in-swarm integrations (QA-042).
 *
 * The controller lives on the private `swarmy-control` overlay only (the
 * network wall), so any in-swarm URL it dials was unreachable: an
 * auto-discovered Ollama/vLLM behind the AI gateway (502), an alert channel
 * pointing at `http://<stack>_ntfy`, an outbound webhook to an in-swarm
 * receiver. `swarmy-integrations` is the one bridge: the controller joins it,
 * and this reconcile attaches exactly the services the controller must dial,
 * and detaches everything else that ended up there. Apps are never attached
 * by default, and nothing of the control plane (ClickHouse, the store) is on
 * it, so the control-plane isolation stands.
 */
import { buildInventory, SWARMY_INTEGRATIONS_NETWORK, type InvService } from '@swarmy/core';
import type { OrgContext } from '../context';
import { resolveManagerNode } from './dispatch.service';
import { promoteSpecFrom } from './releases.service';
import { inClusterHosts } from './ai.service';
import { channelEndpointUrls } from './alerts.service';
import { overlayOptionsFor } from './platform-networks';

const CONTROLLER_SERVICE = 'swarmy_controller';

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.includes('://') ? url : `http://${url}`);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * PURE — which live services the URLs name. A host matches a service by its
 * swarm name (`qa6-ollama_ollama`) or Docker's `tasks.<name>` form. Public
 * hosts match nothing (they need no bridge). swarmy's own services never count.
 */
export function integrationTargets(urls: readonly string[], services: ReadonlyArray<Pick<InvService, 'name'>>): string[] {
  const byName = new Map(services.map((s) => [s.name.toLowerCase(), s.name]));
  const out = new Set<string>();
  for (const url of urls) {
    const host = hostOf(url);
    if (!host) continue;
    const name = byName.get(host) ?? byName.get(host.replace(/^tasks\./, ''));
    if (name && name !== CONTROLLER_SERVICE && !/^swarmy[-_]/.test(name)) out.add(name);
  }
  return [...out].sort();
}

export interface IntegrationsPlan {
  attach: string[];
  detach: string[];
  /** The controller must join the overlay (a targets exists and it isn't on it yet). */
  controller: boolean;
}

/** PURE — converge the overlay's membership onto `targets`. */
export function planIntegrations(
  services: ReadonlyArray<Pick<InvService, 'name' | 'networks'>>,
  targets: readonly string[],
): IntegrationsPlan {
  const want = new Set(targets);
  const on = (s: { networks: { name: string }[] }) => s.networks.some((n) => n.name === SWARMY_INTEGRATIONS_NETWORK);
  const attach = services.filter((s) => want.has(s.name) && !on(s)).map((s) => s.name);
  const detach = services
    .filter((s) => on(s) && !want.has(s.name) && s.name !== CONTROLLER_SERVICE && !/^swarmy[-_]/.test(s.name))
    .map((s) => s.name);
  const ctl = services.find((s) => s.name === CONTROLLER_SERVICE);
  return { attach, detach, controller: want.size > 0 && !!ctl && !on(ctl) };
}

async function endpointUrls(ctx: OrgContext): Promise<string[]> {
  const ai = inClusterHosts(ctx).map((h) => `http://${h}`);
  const channels = await channelEndpointUrls(ctx).catch(() => [] as string[]);
  const hooks = await (ctx.db as unknown as { webhookEndpoint?: { findMany(a: unknown): Promise<Array<{ url: string }>> } })
    .webhookEndpoint?.findMany({ where: { orgId: ctx.activeOrgId, active: true }, select: { url: true } })
    .then((r) => r.map((x) => x.url))
    .catch(() => [] as string[]);
  return [...ai, ...channels, ...(hooks ?? [])];
}

/**
 * One reconcile pass: ensure the overlay, attach targets, detach strays, and
 * put the controller on it (a one-off rolling update of the controller,
 * only on installs that predate the overlay and only once a target exists).
 */
export async function reconcileIntegrationsNetwork(ctx: OrgContext): Promise<IntegrationsPlan> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services;
  const targets = integrationTargets(await endpointUrls(ctx), live);
  const plan = planIntegrations(live, targets);
  if (!plan.attach.length && !plan.detach.length && !plan.controller) return plan;

  const node = await resolveManagerNode(ctx);
  const options = await overlayOptionsFor(ctx, { encrypted: true }).catch(() => undefined);
  await ctx.hub
    .dispatch(node.id, 'network.ensure', {
      name: SWARMY_INTEGRATIONS_NETWORK,
      driver: 'overlay',
      attachable: true,
      labels: { 'swarmy.managed': 'true', 'swarmy.role': 'integrations' },
      ...(options ? { options } : {}),
    })
    .catch(() => undefined);

  const rewire = async (name: string, add: boolean) => {
    const svc = live.find((s) => s.name === name);
    if (!svc) return;
    const raw = await ctx.hub.dispatch<{ inspect?: unknown }>(node.id, 'service.inspect', { service: name });
    const nets = svc.networks.map((n) => n.name).filter((n) => n !== SWARMY_INTEGRATIONS_NETWORK);
    const spec = promoteSpecFrom(raw?.inspect, svc.image, add ? [...nets, SWARMY_INTEGRATIONS_NETWORK] : nets);
    if (spec) await ctx.hub.dispatch(node.id, 'service.deploy', { spec });
  };
  for (const name of plan.attach) await rewire(name, true).catch(() => undefined);
  for (const name of plan.detach) await rewire(name, false).catch(() => undefined);
  if (plan.controller) {
    // The controller's spec carries secrets, host-mode ports and the lease:
    // add ONE network with the Docker CLI, never a spec rebuild.
    const { dockerCliPayload } = await import('./platform-upgrade.service');
    await ctx.hub
      .dispatch(
        node.id,
        'container.runOnce',
        dockerCliPayload(
          `docker service update --quiet --detach --network-add ${SWARMY_INTEGRATIONS_NETWORK} ${CONTROLLER_SERVICE}`,
          {},
          120_000,
        ),
        { timeoutMs: 150_000 },
      )
      .catch(() => undefined);
  }
  return plan;
}
