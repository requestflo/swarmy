import { createHmac } from 'node:crypto';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { resolveManagerNode } from './dispatch.service';
import { mapDispatchError } from '../errors';

/**
 * swarmy-dns deployment — mirror of `ensureCaddyController`, but GLOBAL mode
 * with HOST-MODE ports (invariants #2/#3, geo-edge-routing skill): one task on
 * every node labeled ingress+outlet, answering on that node's own address so
 * NS glue records point at real, stable endpoints.
 *
 * The admin bearer token is DERIVED (HMAC of the org id under the controller
 * secret) — nothing to store or rotate in the DB. It reaches swarmy-dns as a
 * Docker secret and reaches the agent JIT on each `dns.apply` frame.
 */

export const DNS_SERVICE = 'swarmy-dns';
export const DNS_ADMIN_SECRET = 'swarmy-dns-admin';
export const DNS_ADMIN_PORT = 53535;
const DEFAULT_DNS_IMAGE = process.env.SWARMY_DNS_IMAGE ?? 'ghcr.io/requestflo/swarmy-dns:latest';

export type GeoIpSource = 'dbip' | 'maxmind' | 'file' | 'off';

/** Parsed shape of `GeoDnsConfig.settings` — references only, never secrets. */
export interface DnsOrgSettings {
  geoipSource: GeoIpSource;
  /** Docker secret holding a MaxMind license key (geoipSource=maxmind). */
  maxmindLicenseSecretRef?: string;
  /** Docker config holding a prebuilt mmdb (geoipSource=file, air-gapped). */
  mmdbConfigRef?: string;
}

export function parseDnsOrgSettings(raw: unknown): DnsOrgSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const source = str(o.geoipSource);
  return {
    geoipSource:
      source === 'maxmind' || source === 'file' || source === 'off' ? source : 'dbip',
    maxmindLicenseSecretRef: str(o.maxmindLicenseSecretRef),
    mmdbConfigRef: str(o.mmdbConfigRef),
  };
}

/** Derived admin token — deterministic per org, never persisted. */
export function dnsAdminToken(orgId: string): string {
  const secret = process.env.SWARMY_SECRET_KEY;
  if (!secret) throw new Error('SWARMY_SECRET_KEY is not set — required for the DNS admin token');
  return createHmac('sha256', secret).update(`dns-admin:${orgId}`).digest('hex');
}

const MMDB_FILE_PATH = '/etc/swarmy-dns/city.mmdb';

export function dnsServiceSpec(settings: DnsOrgSettings, image = DEFAULT_DNS_IMAGE): ServiceSpec {
  return {
    name: DNS_SERVICE,
    image,
    mode: { global: {} },
    labels: {
      'swarmy.managed': 'true',
      'swarmy.role': 'dns',
    },
    env: {
      SWARMY_DNS_GEOIP: settings.geoipSource,
      ...(settings.geoipSource === 'file' ? { SWARMY_DNS_GEOIP_FILE: MMDB_FILE_PATH } : {}),
    },
    ports: [
      { target: 53, published: 53, protocol: 'udp', mode: 'host' },
      { target: 53, published: 53, protocol: 'tcp', mode: 'host' },
      { target: DNS_ADMIN_PORT, published: DNS_ADMIN_PORT, protocol: 'tcp', mode: 'host' },
    ],
    mounts: [{ type: 'volume', source: 'swarmy-dns-data', target: '/var/lib/swarmy-dns' }],
    secrets: [
      { source: DNS_ADMIN_SECRET, target: DNS_ADMIN_SECRET },
      ...(settings.geoipSource === 'maxmind' && settings.maxmindLicenseSecretRef
        ? [{ source: settings.maxmindLicenseSecretRef, target: 'maxmind-license' }]
        : []),
    ],
    configs:
      settings.geoipSource === 'file' && settings.mmdbConfigRef
        ? [{ source: settings.mmdbConfigRef, target: MMDB_FILE_PATH }]
        : undefined,
    placement: {
      constraints: [
        'node.labels.swarmy.node.ingress == true',
        'node.labels.swarmy.node.outlet == true',
      ],
    },
    restartPolicy: { condition: 'any' },
  };
}

/**
 * Deploy/converge the swarmy-dns global service (idempotent, like
 * `ensureCaddyController`): ensure the admin-token secret exists, then
 * `service.deploy`. Global mode + label constraints = marking a node
 * ingress+outlet materializes a nameserver there automatically.
 */
export async function ensureDnsService(
  ctx: OrgContext,
  settings: DnsOrgSettings,
): Promise<{ name: string }> {
  const node = await resolveManagerNode(ctx);

  // Docker secrets are immutable; create is idempotent-by-name (EEXIST is fine).
  const token = dnsAdminToken(ctx.activeOrgId);
  await ctx.hub
    .dispatch(node.id, 'secret.create', {
      name: DNS_ADMIN_SECRET,
      dataB64: Buffer.from(token, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', 'swarmy.secret.family': 'dns-admin' },
    })
    .catch(() => undefined);

  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', {
      spec: dnsServiceSpec(settings),
      pullPolicy: 'missing',
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  return { name: DNS_SERVICE };
}

/** Tear the DNS service down (zone disable / org offboarding). */
export async function removeDnsService(ctx: OrgContext): Promise<void> {
  const node = await resolveManagerNode(ctx);
  await ctx.hub.dispatch(node.id, 'service.remove', { name: DNS_SERVICE }).catch(() => undefined);
}
