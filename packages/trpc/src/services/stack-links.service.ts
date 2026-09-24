/**
 * "Connect apps" — explicit, per-pair private networking between two apps
 * (stacks) of ONE org. Apps are isolated by default (each has only its
 * `<app>_default` overlay); connecting `shop` ↔ `billing` creates one private
 * overlay for exactly that pair, `swarmy-link-<hash(org, a, b)>`, and attaches
 * every APP service of both, aliased `<service>.<app>` — so `shop`'s code
 * reaches `http://api.billing:8080` (and `billing_api:8080`). Never a flat
 * network: a third app sees neither, and each pair is its own overlay.
 *
 * Docker is the truth (docker-native-storage): the pairing IS the network +
 * the `swarmy.links` label on each service (sorted peer list). No DB row.
 * Managed-data members (a stack's db/cache/search/vector services) are NOT
 * linked — a connected peer reaches the other app, not its database.
 */
import {
  LINK_ORG_LABEL,
  LINK_STACKS_LABEL,
  LINKS_LABEL,
  linkAlias,
  linkNetworkName,
  linkPair,
  parseLinksLabel,
  renderLinksLabel,
  SYSTEM_STACK_LABEL,
  buildInventory,
  isSystemStack,
  type InvService,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { overlayOptionsFor } from './platform-networks';
import { patchLiveService, type ServicePatch } from './service-patch';

/** Label prefixes that mark a service as a managed-data MEMBER (never linked). */
const MANAGED_MEMBER_LABELS = ['swarmy.db.cluster', 'swarmy.cache.cluster', 'swarmy.search.engine', 'swarmy.vector.name'];

/** True for an app service a link may attach (not a managed-data member / system service). Pure. */
export function isLinkableService(s: Pick<InvService, 'labels'>): boolean {
  if (s.labels[SYSTEM_STACK_LABEL] === 'true') return false;
  return !MANAGED_MEMBER_LABELS.some((k) => k in s.labels);
}

/** The compose short name of `service` in `stack` (`shop_web` → `web`). Pure. */
export function shortName(stack: string, service: string): string {
  return service.startsWith(`${stack}_`) ? service.slice(stack.length + 1) : service;
}

/**
 * The patch that makes a live service's link networks match `peers`: joins
 * each peer's pair overlay with alias `<short>.<stack>`, leaves overlays of
 * dropped peers, and stamps `swarmy.links`. Aliases are set EXPLICITLY for
 * every network (the live ones carried from inventory) because a spec that
 * sets `networkAliases` is authoritative on the agent. Pure.
 */
export function linkPatch(
  orgId: string,
  stack: string,
  svc: Pick<InvService, 'name' | 'labels' | 'networks'>,
  peers: readonly string[],
): ServicePatch {
  const want = new Set(peers);
  const current = parseLinksLabel(svc.labels[LINKS_LABEL]);
  const add = [...want].map((p) => linkNetworkName(orgId, stack, p));
  const remove = current.filter((p) => !want.has(p)).map((p) => linkNetworkName(orgId, stack, p));
  const alias = linkAlias(stack, shortName(stack, svc.name));
  const label = renderLinksLabel(want);
  return {
    ...(label ? { setLabels: { [LINKS_LABEL]: label } } : { removeLabels: [LINKS_LABEL] }),
    addNetworks: add,
    removeNetworks: remove,
    transform: (spec: ServiceSpec): ServiceSpec => {
      const aliases: Record<string, string[]> = {};
      for (const n of svc.networks) if (n.aliases.length && !remove.includes(n.name)) aliases[n.name] = [...n.aliases];
      for (const net of add) aliases[net] = [alias];
      return { ...spec, networkAliases: aliases };
    },
  };
}

/**
 * Compose redeploys rebuild each spec from the file; carry the live link
 * membership (label + pair overlays + `<short>.<stack>` alias) onto it. A
 * service new to a linked stack inherits the stack's links. Pure.
 */
export function carryLinks(
  spec: ServiceSpec,
  opts: { orgId: string; stack: string; peers: readonly string[] },
): ServiceSpec {
  if (!opts.peers.length || !isLinkableService({ labels: spec.labels ?? {} })) return spec;
  const nets = opts.peers.map((p) => linkNetworkName(opts.orgId, opts.stack, p));
  const alias = linkAlias(opts.stack, shortName(opts.stack, spec.name));
  const networkAliases = { ...(spec.networkAliases ?? {}) };
  for (const n of nets) networkAliases[n] = [alias];
  return {
    ...spec,
    labels: { ...(spec.labels ?? {}), [LINKS_LABEL]: renderLinksLabel(opts.peers) },
    networks: [...new Set([...(spec.networks ?? []), ...nets])],
    networkAliases,
  };
}

/** Peer apps a stack is connected to — the union of its services' `swarmy.links`. Pure. */
export function stackPeers(services: readonly Pick<InvService, 'labels'>[]): string[] {
  const out = new Set<string>();
  for (const s of services) for (const p of parseLinksLabel(s.labels[LINKS_LABEL])) out.add(p);
  return [...out].sort();
}

function liveStack(ctx: OrgContext, stack: string): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services.filter((s) => s.stack === stack);
}

function assertApp(ctx: OrgContext, stack: string): InvService[] {
  if (isSystemStack(stack)) throw commandRejected(`"${stack}" is a platform stack and can't be connected`);
  const svcs = liveStack(ctx, stack);
  if (svcs.length === 0) throw notFound('stack', stack);
  if (svcs.some((s) => s.labels[SYSTEM_STACK_LABEL] === 'true')) {
    throw commandRejected(`"${stack}" is a platform stack and can't be connected`);
  }
  return svcs;
}

export interface StackLinkResult {
  stack: string;
  peer: string;
  network: string;
  /** Services re-deployed onto (or off) the pair network. */
  services: string[];
}

async function applyPeers(
  ctx: OrgContext,
  nodeId: string,
  stack: string,
  svcs: InvService[],
  mutate: (peers: Set<string>) => void,
): Promise<string[]> {
  const peers = new Set(stackPeers(svcs));
  mutate(peers);
  const changed: string[] = [];
  for (const svc of svcs.filter(isLinkableService)) {
    const current = parseLinksLabel(svc.labels[LINKS_LABEL]);
    if (renderLinksLabel(current) === renderLinksLabel(peers)) continue;
    await patchLiveService(ctx, svc, linkPatch(ctx.activeOrgId, stack, svc, [...peers]), { nodeId });
    changed.push(svc.name);
  }
  return changed;
}

/**
 * Connect two apps of the caller's org. Idempotent: an existing pairing is a
 * no-op (services already on it are not redeployed). Every app service of
 * both stacks rolls once to join the pair overlay.
 */
export async function connectStacks(ctx: OrgContext, input: { stack: string; peer: string }): Promise<StackLinkResult> {
  const [a, b] = linkPair(input.stack.trim(), input.peer.trim());
  if (!a || !b || a === b) throw commandRejected('pick two different apps to connect');
  const svcsA = assertApp(ctx, a);
  const svcsB = assertApp(ctx, b);
  const network = linkNetworkName(ctx.activeOrgId, a, b);
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'network.ensure', {
      name: network,
      driver: 'overlay',
      attachable: false,
      labels: {
        'swarmy.managed': 'true',
        'swarmy.role': 'link',
        [LINK_ORG_LABEL]: ctx.activeOrgId,
        [LINK_STACKS_LABEL]: `${a},${b}`,
      },
      options: await overlayOptionsFor(ctx),
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  const services = [
    ...(await applyPeers(ctx, node.id, a, svcsA, (p) => p.add(b))),
    ...(await applyPeers(ctx, node.id, b, svcsB, (p) => p.add(a))),
  ];
  await writeAudit(ctx, {
    action: 'stack.link.add',
    targetType: 'stack',
    targetId: `${a}<->${b}`,
    metadata: { stacks: [a, b], network, services },
  });
  return { stack: input.stack, peer: input.peer, network, services };
}

/**
 * Disconnect two apps: every service of both leaves the pair overlay and
 * drops the peer from `swarmy.links`. The now-empty overlay object is left in
 * place (no endpoints = no reachability; a reconnect reuses it).
 */
export async function disconnectStacks(
  ctx: OrgContext,
  input: { stack: string; peer: string },
): Promise<StackLinkResult> {
  const [a, b] = linkPair(input.stack.trim(), input.peer.trim());
  if (!a || !b || a === b) throw commandRejected('pick two different apps to disconnect');
  const network = linkNetworkName(ctx.activeOrgId, a, b);
  const node = await resolveManagerNode(ctx);
  const services: string[] = [];
  // A peer stack that no longer exists is fine — detach whichever side remains.
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const svcs = liveStack(ctx, self);
    if (svcs.length) services.push(...(await applyPeers(ctx, node.id, self, svcs, (p) => p.delete(other))));
  }
  await writeAudit(ctx, {
    action: 'stack.link.remove',
    targetType: 'stack',
    targetId: `${a}<->${b}`,
    metadata: { stacks: [a, b], network, services },
  });
  return { stack: input.stack, peer: input.peer, network, services };
}
