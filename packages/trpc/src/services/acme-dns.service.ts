/**
 * ACME DNS-01 for wildcard certificates — the controller half.
 *
 * Primary path, no third party: the org's zone is served by swarmy-dns (NS
 * delegated to its ingress+outlet nodes). The edge Caddy's `dns swarmy`
 * provider calls `POST /ingress/acme-dns/<orgId>/{present,cleanup}` with a
 * bearer token it reads from a Docker secret; this module checks the name is
 * the org's own (`checkChallengeName`), stages the TXT (acme-challenges.ts),
 * and pushes the zone snapshot to EVERY swarmy-dns node before answering — so
 * whichever nameserver Let's Encrypt asks already serves it.
 *
 * Optional secondary: a bring-your-own DNS provider token (Cloudflare) for a
 * wildcard whose zone swarmy does not serve. The token goes straight into a
 * Docker secret; only the secret NAME is persisted (IngressConfig.settings
 * `acmeDns.byo`) and the edge reads it with a `{file.*}` placeholder.
 *
 * Tokens: the swarmy token is DERIVED (HMAC of the org id under
 * SWARMY_SECRET_KEY, like the swarmy-dns admin token) — nothing to store. Its
 * Docker secret is named by a hash of its content, so a key rotation yields a
 * new secret (secrets are immutable) and the edge rolls onto it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ACME_DNS_SECRET_TARGET,
  ACME_DNS_TOKEN_FILE,
  BYO_DNS_PROVIDERS,
  BYO_DNS_SECRET_TARGET,
  BYO_DNS_TOKEN_FILE,
  checkChallengeName,
  isChallengeValue,
  planDnsChallenges,
  type ByoDnsProvider,
  type DnsChallenge,
  type DnsChallengeProvider,
} from '@swarmy/ingress';
import type { SecretListResult } from '@swarmy/core/protocol';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import { mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { dnsZoneRepo } from './geodns.repo';
import { listRoutesForOrg } from './ingress-routes';
import { removeChallenge, stageChallenge } from './acme-challenges';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';

/** Non-secret DNS-01 coordinates persisted on `IngressConfig.settings.acmeDns`. */
export interface AcmeDnsSettings {
  /** Docker secret NAME carrying the derived swarmy token. */
  swarmySecret?: string;
  /** BYO provider for zones swarmy does not serve — secret NAME only. */
  byo?: { provider: ByoDnsProvider; secretName: string; setAt: string };
}

export function readAcmeDnsSettings(settings: unknown): AcmeDnsSettings {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).acmeDns : undefined;
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: AcmeDnsSettings = {};
  if (typeof o.swarmySecret === 'string' && o.swarmySecret) out.swarmySecret = o.swarmySecret;
  const b = o.byo as Record<string, unknown> | undefined;
  if (
    b &&
    typeof b.secretName === 'string' &&
    (BYO_DNS_PROVIDERS as readonly string[]).includes(String(b.provider))
  ) {
    out.byo = { provider: b.provider as ByoDnsProvider, secretName: b.secretName, setAt: String(b.setAt ?? '') };
  }
  return out;
}

// ───────────────────────────────────────────── token ──

/** The derived per-org bearer the edge presents (never persisted). */
export function acmeDnsToken(orgId: string): string {
  const secret = process.env.SWARMY_SECRET_KEY;
  if (!secret) throw new Error('SWARMY_SECRET_KEY is not set — required for the ACME DNS token');
  return createHmac('sha256', secret).update(`acme-dns:${orgId}`).digest('hex');
}

/** Constant-time check of an `Authorization: Bearer …` header. */
export function verifyAcmeDnsAuth(orgId: string, header: string | null | undefined): boolean {
  const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
  if (!m) return false;
  let want: Buffer;
  try {
    want = Buffer.from(acmeDnsToken(orgId));
  } catch {
    return false;
  }
  const got = Buffer.from(m[1]!);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Docker secret name for a token (content-addressed: immutable secrets never collide). Pure. */
export function acmeDnsSecretName(token: string): string {
  return `swarmy-acme-dns-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/** Where the edge dials the controller (same overlay name the dashboard vhost uses). */
export function acmeDnsEndpoint(orgId: string): string {
  const upstream = process.env.SWARMY_DASHBOARD_UPSTREAM || 'swarmy_controller:3021';
  return `http://${upstream}/ingress/acme-dns/${encodeURIComponent(orgId)}`;
}

/** Edge-service secret mounts for DNS-01. Pure — merged by both Caddy spec builders. */
export function acmeDnsServiceSecrets(
  s: AcmeDnsSettings,
): Array<{ source: string; target: string; mode: number }> {
  return [
    ...(s.swarmySecret ? [{ source: s.swarmySecret, target: ACME_DNS_SECRET_TARGET, mode: 0o400 }] : []),
    ...(s.byo ? [{ source: s.byo.secretName, target: BYO_DNS_SECRET_TARGET, mode: 0o400 }] : []),
  ];
}

async function swarmSecretNames(ctx: OrgContext, nodeId: string): Promise<Set<string> | null> {
  try {
    const res = await ctx.hub.dispatch<SecretListResult>(nodeId, 'secret.list', {});
    return new Set((res?.secrets ?? []).map((s) => s.name));
  } catch {
    return null;
  }
}

/** Create the swarmy token's Docker secret if missing; returns its name. */
export async function ensureAcmeDnsSecret(ctx: OrgContext): Promise<string> {
  const token = acmeDnsToken(ctx.activeOrgId);
  const name = acmeDnsSecretName(token);
  const node = await resolveManagerNode(ctx);
  const names = await swarmSecretNames(ctx, node.id);
  if (names?.has(name)) return name;
  try {
    await ctx.hub.dispatch(node.id, 'secret.create', {
      name,
      dataB64: Buffer.from(token, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress-acme-dns' },
    });
  } catch (e) {
    // Already exists (list failed / raced) is fine; anything else is real.
    if (!/exist/i.test(e instanceof Error ? e.message : String(e))) throw mapDispatchError(e);
  }
  return name;
}

// ───────────────────────────────────────────── zones + plan ──

/** Apexes of the org's enabled swarmy-ns zones (the ones swarmy-dns answers for). */
export async function swarmyZones(ctx: OrgContext): Promise<string[]> {
  const rows = await dnsZoneRepo.list(ctx, ctx.activeOrgId, { enabled: true, mode: 'swarmy-ns' }).catch(() => []);
  return rows.map((r) => r.zone);
}

/**
 * The render-time DNS-01 block for the org's routed hosts (undefined when no
 * wildcard is routed — the render then stays byte-identical).
 */
export async function orgDnsChallenge(
  ctx: OrgContext,
  hosts: readonly string[],
  settings: unknown,
): Promise<{ dnsChallenge: DnsChallenge | undefined; unsolvable: string[] }> {
  if (!hosts.some((h) => h.startsWith('*.'))) return { dnsChallenge: undefined, unsolvable: [] };
  const acme = readAcmeDnsSettings(settings);
  const plan = planDnsChallenges({
    hosts,
    swarmyZones: await swarmyZones(ctx),
    byoProvider: acme.byo?.provider ?? null,
  });
  if (Object.keys(plan.hosts).length === 0) return { dnsChallenge: undefined, unsolvable: plan.unsolvable };
  const uses = (p: DnsChallengeProvider) => Object.values(plan.hosts).includes(p);
  return {
    dnsChallenge: {
      hosts: plan.hosts,
      ...(uses('swarmy') ? { swarmy: { endpoint: acmeDnsEndpoint(ctx.activeOrgId), tokenFile: ACME_DNS_TOKEN_FILE } } : {}),
      ...(uses('cloudflare') ? { cloudflare: { tokenFile: BYO_DNS_TOKEN_FILE } } : {}),
    },
    unsolvable: plan.unsolvable,
  };
}

/** Secrets the edge must mount for this plan — the reconcile rolls the edge when one is missing. */
export function requiredAcmeDnsSecrets(dc: DnsChallenge | undefined, s: AcmeDnsSettings): string[] {
  if (!dc) return [];
  const need: string[] = [];
  if (dc.swarmy) need.push(s.swarmySecret ?? '(swarmy token not provisioned)');
  if (dc.cloudflare && s.byo) need.push(s.byo.secretName);
  return need;
}

// ───────────────────────────────────────────── challenge API ──

export interface ChallengeResult {
  status: 200 | 400 | 403 | 503;
  body: string;
}

type Pusher = (ctx: OrgContext) => Promise<{ pushed: string[]; failed: Array<{ nodeId: string; error: string }> }>;

async function defaultPush(ctx: OrgContext) {
  const { composeAndPushDns } = await import('./dns-push.service');
  return composeAndPushDns(ctx);
}

/**
 * `present` / `cleanup` one challenge. Refuses any name that is not
 * `_acme-challenge.<host>` for a host (or `*.host`) the org routes inside one
 * of its swarmy zones. `present` answers only once at least one nameserver
 * holds the TXT (Caddy then polls the authoritative set for propagation).
 */
export async function handleAcmeChallenge(
  ctx: OrgContext,
  action: 'present' | 'cleanup',
  body: unknown,
  push: Pusher = defaultPush,
): Promise<ChallengeResult> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof b.fqdn !== 'string' || !isChallengeValue(b.value)) {
    return { status: 400, body: 'expected {"fqdn": "_acme-challenge.<name>", "value": "<digest>"}' };
  }
  const check = checkChallengeName({
    fqdn: b.fqdn,
    routedHosts: listRoutesForOrg(ctx).map((r) => r.route.host),
    zones: await swarmyZones(ctx),
  });
  if (!check.ok) return { status: check.status, body: check.reason };
  const staged = { zone: check.zone, relName: check.relName, value: b.value };

  if (action === 'cleanup') {
    if (removeChallenge(ctx.activeOrgId, staged)) await push(ctx).catch(() => undefined);
    return { status: 200, body: 'ok' };
  }
  stageChallenge(ctx.activeOrgId, staged);
  const res = await push(ctx).catch((e: unknown) => ({
    pushed: [] as string[],
    failed: [{ nodeId: '*', error: e instanceof Error ? e.message : String(e) }],
  }));
  await writeAudit(ctx, {
    action: 'ingress.acmeDnsChallenge',
    actorType: 'system',
    targetType: 'dnsZone',
    targetId: check.zone,
    metadata: { name: `_acme-challenge.${check.base}`, nameservers: res.pushed.length, failed: res.failed.length },
  }).catch(() => undefined);
  if (res.pushed.length === 0) {
    return {
      status: 503,
      body: `no swarmy nameserver accepted the challenge${res.failed[0] ? `: ${res.failed[0].error}` : ''}`,
    };
  }
  return { status: 200, body: `published on ${res.pushed.length} nameserver(s)` };
}

// ───────────────────────────────────────────── BYO provider ──

export interface DnsChallengeView {
  /** Zones swarmy-dns serves — wildcards inside them need nothing else. */
  swarmyZones: string[];
  /** The BYO provider (token never returned), or null. */
  byo: { provider: ByoDnsProvider; setAt: string } | null;
  /** Every routed wildcard and who solves it (null = nobody yet). */
  wildcards: Array<{ host: string; provider: DnsChallengeProvider | null }>;
}

export async function getDnsChallengeView(ctx: OrgContext): Promise<DnsChallengeView> {
  const row = await ingressConfigRepo.get(ctx, ctx.activeOrgId);
  const acme = readAcmeDnsSettings(row.settings);
  const zones = await swarmyZones(ctx);
  const hosts = listRoutesForOrg(ctx).map((r) => r.route.host.toLowerCase());
  const plan = planDnsChallenges({ hosts, swarmyZones: zones, byoProvider: acme.byo?.provider ?? null });
  return {
    swarmyZones: zones,
    byo: acme.byo ? { provider: acme.byo.provider, setAt: acme.byo.setAt } : null,
    wildcards: [
      ...Object.entries(plan.hosts).map(([host, provider]) => ({ host, provider })),
      ...plan.unsolvable.map((host) => ({ host, provider: null })),
    ].sort((a, b) => (a.host < b.host ? -1 : 1)),
  };
}

/**
 * Set (or clear, `null`) the BYO DNS provider token. The token goes into a
 * fresh Docker secret and is never stored or returned; the next ingress
 * reconcile rolls the edge onto the new secret.
 */
export async function setByoDnsProvider(
  ctx: OrgContext,
  input: { provider: ByoDnsProvider; apiToken: string } | null,
): Promise<DnsChallengeView> {
  const row = await ingressConfigRepo.get(ctx, ctx.activeOrgId);
  const acme = readAcmeDnsSettings(ingressSettingsOf(row));
  let byo: AcmeDnsSettings['byo'];
  if (input) {
    const token = input.apiToken.trim();
    if (token.length < 20 || /\s/.test(token)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'that does not look like an API token' });
    }
    const node = await resolveManagerNode(ctx);
    const secretName = `swarmy-acme-dns-byo-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
    try {
      await ctx.hub.dispatch(node.id, 'secret.create', {
        name: secretName,
        dataB64: Buffer.from(token, 'utf8').toString('base64'),
        labels: { 'swarmy.managed': 'true', 'swarmy.role': 'ingress-acme-dns-byo' },
      });
    } catch (e) {
      if (!/exist/i.test(e instanceof Error ? e.message : String(e))) throw mapDispatchError(e);
    }
    byo = { provider: input.provider, secretName, setAt: new Date().toISOString() };
  }
  const next: AcmeDnsSettings = { ...acme, byo };
  if (!byo) delete next.byo;
  await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => ({
    settings: { ...ingressSettingsOf(cur), acmeDns: next },
  }));
  await writeAudit(ctx, {
    action: input ? 'ingress.setDnsProvider' : 'ingress.clearDnsProvider',
    targetType: 'ingressConfig',
    targetId: ctx.activeOrgId,
    metadata: input ? { provider: input.provider, secretName: byo?.secretName } : {},
  });
  return getDnsChallengeView(ctx);
}

/** Persist the swarmy token secret name (settings merge, called by the edge converge). */
export async function recordAcmeDnsSecret(ctx: OrgContext, secretName: string): Promise<void> {
  await ingressConfigRepo.update(ctx, ctx.activeOrgId, (cur) => {
    const settings = ingressSettingsOf(cur);
    const acme = readAcmeDnsSettings(settings);
    if (acme.swarmySecret === secretName) return undefined; // unchanged: no raft write
    return { settings: { ...settings, acmeDns: { ...acme, swarmySecret: secretName } } };
  });
}

/**
 * The DNS-01 secret mounts the edge needs right now (provisions the swarmy
 * token secret on first need). [] when no routed wildcard uses DNS-01 — so an
 * org without wildcards never gets an edge roll for this feature.
 */
export async function edgeAcmeDnsSecrets(
  ctx: OrgContext,
  settings: unknown,
): Promise<Array<{ source: string; target: string; mode: number }>> {
  const hosts = listRoutesForOrg(ctx).map((r) => r.route.host.toLowerCase());
  const { dnsChallenge } = await orgDnsChallenge(ctx, hosts, settings);
  if (!dnsChallenge) return [];
  const acme = readAcmeDnsSettings(settings);
  let swarmySecret: string | undefined;
  if (dnsChallenge.swarmy) {
    swarmySecret = await ensureAcmeDnsSecret(ctx);
    await recordAcmeDnsSecret(ctx, swarmySecret);
  }
  return acmeDnsServiceSecrets({ swarmySecret, byo: dnsChallenge.cloudflare ? acme.byo : undefined });
}

/**
 * HTTP entry for `/ingress/acme-dns/:orgId/:action` (apps/api): bearer check
 * FIRST (constant time, before any DB read), then the challenge under the
 * SYSTEM actor for that org.
 */
export async function acmeDnsRequest(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  input: { orgId: string; action: string; authorization: string | null | undefined; body: unknown },
): Promise<ChallengeResult> {
  if (!verifyAcmeDnsAuth(input.orgId, input.authorization)) return { status: 403, body: 'unauthorized' };
  if (input.action !== 'present' && input.action !== 'cleanup') return { status: 400, body: 'unknown action' };
  const { systemContext } = await import('./cicd.service');
  return handleAcmeChallenge(systemContext(deps, input.orgId), input.action, input.body);
}
