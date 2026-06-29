/**
 * Tunnel service (ingress-strategy epic) — controller-side Cloudflare tunnel
 * lifecycle. Wires the {@link CloudflareClient} to the persisted ingress
 * settings + the connector deploy path.
 *
 * Persistence note: an org's tunnel currently lives in `IngressConfig.settings`
 * (the `tunnel` block, secrets encrypted). A dedicated `Tunnel` Prisma model is
 * provided as an INTEGRATION snippet for a future migration; this service is
 * written so swapping the storage backend is a localized change.
 *
 * Secrets discipline: the CF API token / run token are decrypted just-in-time
 * for the API call or the dispatched render and are NEVER returned to clients.
 */
import { buildCloudflaredIngressRules } from '@swarmy/ingress';
import { decryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { writeAudit } from '../services/audit.service';
import {
  CloudflareClient,
  type CloudflareClientOptions,
  type CloudflareIngressRule,
} from './cloudflare.client';
import { applyNow, loadOrgConfigForTunnels, setTunnel } from './ingress.service';
import { listRoutesForOrg } from './ingress-routes';

export interface TunnelView {
  provider: 'cloudflare';
  tunnelId: string | null;
  tunnelName: string;
  accountId: string | null;
  /** True once a CF run token is on file (value never returned). */
  connected: boolean;
  replicas: number;
  domainCount: number;
}

/** Build a CF client from the org's persisted (encrypted) credentials. */
function clientFor(
  apiTokenEnc: string | undefined,
  accountId: string | undefined,
  overrides?: Partial<CloudflareClientOptions>,
): CloudflareClient {
  if (!apiTokenEnc) throw new Error('no Cloudflare API token configured for this org');
  if (!accountId) throw new Error('no Cloudflare account id configured for this org');
  return new CloudflareClient({
    apiToken: decryptSecret(apiTokenEnc),
    accountId,
    ...overrides,
  });
}

/** Read the persisted tunnel block (encrypted refs intact). */
async function readTunnel(ctx: OrgContext) {
  const row = await ctx.db.ingressConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  const settings = (row?.settings as { tunnel?: TunnelSettings } | null) ?? {};
  return settings.tunnel;
}

interface TunnelSettings {
  provider?: 'cloudflare';
  accountId?: string;
  tunnelId?: string;
  tunnelName?: string;
  replicas?: number;
  apiTokenEnc?: string;
  runTokenEnc?: string;
}

export async function getTunnel(ctx: OrgContext): Promise<TunnelView | null> {
  const t = await readTunnel(ctx);
  if (!t) return null;
  // Domain count is Docker-truth: routes across the org's live service labels.
  const domainCount = listRoutesForOrg(ctx).length;
  return {
    provider: 'cloudflare',
    tunnelId: t.tunnelId ?? null,
    tunnelName: t.tunnelName ?? 'swarmy',
    accountId: t.accountId ?? null,
    connected: Boolean(t.runTokenEnc),
    replicas: t.replicas ?? 1,
    domainCount,
  };
}

export async function listTunnels(ctx: OrgContext): Promise<TunnelView[]> {
  const one = await getTunnel(ctx);
  return one ? [one] : [];
}

/**
 * Create a remotely-managed Cloudflare tunnel: call the CF API to create the
 * tunnel (returns id + run token), persist both (token encrypted), then deploy
 * the connector as a Swarm service via the cloudflared driver's render.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function createTunnel(
  ctx: OrgContext,
  input: {
    name: string;
    accountId: string;
    apiToken: string;
    replicas?: number;
  },
  overrides?: Partial<CloudflareClientOptions>,
): Promise<TunnelView> {
  const client = new CloudflareClient({
    apiToken: input.apiToken,
    accountId: input.accountId,
    ...overrides,
  });
  const created = await client.createTunnel(input.name);

  // Persist coords + secrets (encrypted) through the ingress service so the
  // single settings shape stays authoritative.
  await setTunnel(ctx, {
    accountId: input.accountId,
    tunnelId: created.id,
    tunnelName: input.name,
    replicas: input.replicas,
    apiToken: input.apiToken,
    runToken: created.token,
  });

  // Push the initial (empty-but-catch-all) configuration so the tunnel is valid.
  await pushConfiguration(ctx, client, created.id);

  await writeAudit(ctx, {
    action: 'tunnel.create',
    targetType: 'tunnel',
    targetId: created.id,
    metadata: { name: input.name, provider: 'cloudflare' },
  });

  // Deploy the connector as a swarm service (driver render carries the block).
  await applyNow(ctx).catch(() => undefined);

  const view = await getTunnel(ctx);
  if (!view) throw new Error('tunnel creation did not persist');
  return view;
}

/** Recompute + PUT the full CF ingress array (declarative; always idempotent). */
async function pushConfiguration(
  ctx: OrgContext,
  client: CloudflareClient,
  tunnelId: string,
): Promise<void> {
  const config = await loadOrgConfigForTunnels(ctx);
  const rules: CloudflareIngressRule[] = buildCloudflaredIngressRules(config);
  await client.putTunnelConfiguration(tunnelId, rules);
}

/** Re-sync CF ingress rules + (optionally) DNS for the current domains. */
export async function syncTunnel(
  ctx: OrgContext,
  opts?: { zoneId?: string; overrides?: Partial<CloudflareClientOptions> },
): Promise<{ synced: true; rules: number }> {
  const t = await readTunnel(ctx);
  if (!t?.tunnelId) throw new Error('no tunnel to sync');
  const client = clientFor(t.apiTokenEnc, t.accountId, opts?.overrides);
  await pushConfiguration(ctx, client, t.tunnelId);
  const config = await loadOrgConfigForTunnels(ctx);
  if (opts?.zoneId) {
    for (const d of config.domains) {
      await client.upsertDnsCname(opts.zoneId, d.domain, t.tunnelId);
    }
  }
  await writeAudit(ctx, {
    action: 'tunnel.sync',
    targetType: 'tunnel',
    targetId: t.tunnelId,
    metadata: { rules: config.domains.length },
  });
  return { synced: true, rules: config.domains.length };
}

/** Delete the CF tunnel + clear local state (tears down the connector). */
export async function deleteTunnel(
  ctx: OrgContext,
  overrides?: Partial<CloudflareClientOptions>,
): Promise<{ deleted: true }> {
  const t = await readTunnel(ctx);
  if (t?.tunnelId && t.apiTokenEnc && t.accountId) {
    const client = clientFor(t.apiTokenEnc, t.accountId, overrides);
    await client.deleteTunnel(t.tunnelId).catch(() => undefined);
  }
  await setTunnel(ctx, null);
  await writeAudit(ctx, {
    action: 'tunnel.delete',
    targetType: 'tunnel',
    targetId: t?.tunnelId ?? undefined,
    metadata: {},
  });
  return { deleted: true };
}
