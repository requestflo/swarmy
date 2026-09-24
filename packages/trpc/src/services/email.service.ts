/**
 * Email service — the control plane (epic developer-platform §8). The Email
 * page's reads and every mutation, org-scoped; mutations are ABAC-gated at the
 * router (`email.write` / `email.send`) and audited here.
 *
 * Pieces (all under ./email/):
 *   maddy.ts / deploy.ts — the `swarmy-mail` MTA render + converge
 *   dkim.ts / dns.ts     — keys, the records a domain needs, the DNS check
 *   runtime.ts           — the send API, report ingestion, swarmy's own mail
 *   store.ts / log.ts    — the send log (ClickHouse) + process memory
 */
import { promises as dnsPromises } from 'node:dns';
import { encryptSecret, isVaultConfigured } from '@swarmy/core/crypto';
import { DEFAULT_SMTP_PROBE_TARGETS, interpretSmtpProbe, type ProbeSmtpResult, type StaticDnsRecord } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { badRequest, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dnsZoneRepo } from './geodns.repo';
import { observabilityStore } from './observability.service';
import { generateDkimKey } from './email/dkim';
import {
  DMARC_POLICIES,
  checkEmailDns,
  emailDnsRecords,
  emailZoneRecords,
  normalizeEmailDomain,
  relativeTo,
  type DmarcPolicy,
  type EmailDnsCheck,
  type EmailDomainDnsInput,
} from './email/dns';
import {
  convergeMail,
  domainsOf,
  heloHostFor,
  mailAgentNodeId,
  mailNodeIps,
  mailServiceStatus,
  relayOf,
  type RelaySettings,
} from './email/deploy';
import { MAIL_HOST, SUBMISSION_PORT, maddyBcrypt } from './email/maddy';
import {
  CREDENTIAL_NAME_RE,
  SYSTEM_CREDENTIAL,
  isVaultReady,
  newApiKey,
  newWebhookSecret,
  sha256,
  apiKeyFor,
  smtpPasswordFor,
  smtpUsernameFor,
} from './email/keys';
import {
  domainCheck,
  emailLogStoreOf,
  port25Probe,
  readEmailLog,
  setDomainCheck,
  setEmailLogStore,
  setPort25Probe,
  type EmailLogPage,
  type Port25Probe,
} from './email/store';
import type { EmailLogQuery } from './email/log';
import { sendAsCredential, emailApiUrl } from './email/runtime';

// ── shared helpers ───────────────────────────────────────────────────────────

function requireVault(): void {
  if (!isVaultConfigured() || !isVaultReady()) {
    throw badRequest('The email service needs SWARMY_SECRET_KEY (the controller vault key) set on the controller.');
  }
}

async function config(ctx: OrgContext) {
  return ctx.db.emailConfig.upsert({ where: { orgId: ctx.activeOrgId }, create: { orgId: ctx.activeOrgId }, update: {} });
}

async function reconverge(ctx: OrgContext): Promise<void> {
  try {
    await convergeMail(ctx);
  } catch {
    // The reconcile worker retries; the mutation itself succeeded.
  }
}

/** The swarmy-ns zone a domain falls in (longest match), if swarmy serves it. */
async function zoneFor(ctx: OrgContext, domain: string): Promise<{ id: string; zone: string; delegated: boolean } | null> {
  const zones = await dnsZoneRepo.list(ctx, ctx.activeOrgId).catch(() => []);
  const hits = zones
    .filter((z) => z.mode === 'swarmy-ns' && relativeTo(domain, z.zone) !== null)
    .sort((a, b) => b.zone.length - a.zone.length);
  const z = hits[0];
  return z ? { id: z.id, zone: z.zone, delegated: z.enabled } : null;
}

type DomainRow = Awaited<ReturnType<OrgContext['db']['emailDomain']['findMany']>>[number];

function dnsInput(ctx: OrgContext, d: DomainRow, helo: string): EmailDomainDnsInput {
  const relay = relayOf(d.relay);
  return {
    domain: d.domain,
    selector: d.selector,
    dkimPublicKey: d.dkimPublicKey,
    delivery: d.delivery === 'relay' ? 'relay' : 'direct',
    sendingIps: mailNodeIps(ctx),
    relaySpfInclude: relay?.spfInclude ?? null,
    dmarcPolicy: (DMARC_POLICIES as readonly string[]).includes(d.dmarcPolicy) ? (d.dmarcPolicy as DmarcPolicy) : 'none',
    heloHost: helo,
  };
}

async function heloFor(ctx: OrgContext): Promise<string> {
  const [cfg, verified] = await Promise.all([
    ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } }),
    ctx.db.emailDomain.findMany({ where: { orgId: ctx.activeOrgId, verifiedAt: { not: null } }, orderBy: { domain: 'asc' } }),
  ]);
  return heloHostFor(verified, cfg?.systemDomainId);
}

// ── DNS: derived zone records (called by dns-snapshot composeZone) ──────────

/**
 * Email records to fold into a swarmy-dns zone — derived from the org's email
 * domains on every compose, never stored (geo-edge-routing invariant #5).
 */
export async function emailRecordsForZone(
  ctx: OrgContext,
  zone: string,
  manual: ReadonlyArray<Pick<StaticDnsRecord, 'name' | 'type' | 'value'>>,
): Promise<StaticDnsRecord[]> {
  let rows: DomainRow[];
  try {
    rows = await ctx.db.emailDomain.findMany({ where: { orgId: ctx.activeOrgId } });
  } catch {
    return [];
  }
  const inZone = rows.filter((d) => relativeTo(d.domain, zone) !== null);
  if (!inZone.length) return [];
  const helo = await heloFor(ctx);
  return emailZoneRecords(zone, inZone.map((d) => dnsInput(ctx, d, helo)), manual);
}

// ── views ────────────────────────────────────────────────────────────────────

export interface EmailDomainView {
  id: string;
  domain: string;
  selector: string;
  delivery: 'direct' | 'relay';
  relay: (RelaySettings & { passwordSet: boolean }) | null;
  dmarcPolicy: DmarcPolicy;
  verifiedAt: string | null;
  /** swarmy = records are published by swarmy-dns (zone delegated); external = add them yourself. */
  dns: { mode: 'swarmy' | 'external'; zone: string | null; delegated: boolean };
  records: EmailDnsCheck[];
  checkedAt: string | null;
  isSystem: boolean;
}

export interface EmailCredentialView {
  id: string;
  name: string;
  stack: string | null;
  smtpUsername: string;
  apiKeyPrefix: string;
  domains: string[];
  webhookUrl: string | null;
  disabled: boolean;
  system: boolean;
  createdAt: string;
}

export interface EmailOverview {
  enabled: boolean;
  vaultReady: boolean;
  logBodies: boolean;
  systemDomainId: string | null;
  mta: ReturnType<typeof mailServiceStatus> & { host: string; port: number; helo: string; nodeIps: string[] };
  apiUrl: string;
  port25: (Omit<Port25Probe, 'at'> & { at: string }) | null;
  /** Plain-words notices (port 25, fresh IP reputation, PTR, no store). */
  warnings: Array<{ id: string; level: 'info' | 'warn'; message: string }>;
  logStore: 'clickhouse' | 'memory';
  domains: EmailDomainView[];
  credentials: EmailCredentialView[];
  inboundEnabled: boolean;
}

function credentialView(c: Awaited<ReturnType<OrgContext['db']['emailCredential']['findMany']>>[number]): EmailCredentialView {
  return {
    id: c.id,
    name: c.name,
    stack: c.stack,
    smtpUsername: c.smtpUsername,
    apiKeyPrefix: c.apiKeyPrefix,
    domains: domainsOf(c.domains),
    webhookUrl: c.webhookUrl,
    disabled: c.disabled,
    system: c.name === SYSTEM_CREDENTIAL,
    createdAt: c.createdAt.toISOString(),
  };
}

async function domainView(ctx: OrgContext, d: DomainRow, helo: string, systemDomainId: string | null): Promise<EmailDomainView> {
  const relay = relayOf(d.relay);
  const zone = await zoneFor(ctx, d.domain);
  const check = domainCheck(d.id);
  const expected = emailDnsRecords(dnsInput(ctx, d, helo)).map((r): EmailDnsCheck => ({ ...r, status: 'missing', found: [] }));
  return {
    id: d.id,
    domain: d.domain,
    selector: d.selector,
    delivery: d.delivery === 'relay' ? 'relay' : 'direct',
    relay: relay ? { ...relay, passwordSet: Boolean(d.relayPasswordEnc) } : null,
    dmarcPolicy: (DMARC_POLICIES as readonly string[]).includes(d.dmarcPolicy) ? (d.dmarcPolicy as DmarcPolicy) : 'none',
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    dns: { mode: zone ? 'swarmy' : 'external', zone: zone?.zone ?? null, delegated: zone?.delegated ?? false },
    records: check ? check.records : expected,
    checkedAt: check?.checkedAt ?? null,
    isSystem: systemDomainId === d.id,
  };
}

export async function emailOverview(ctx: OrgContext): Promise<EmailOverview> {
  const cfg = await ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  const [domains, creds] = await Promise.all([
    ctx.db.emailDomain.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { domain: 'asc' } }),
    ctx.db.emailCredential.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { name: 'asc' } }),
  ]);
  const verified = domains.filter((d) => d.verifiedAt);
  const helo = heloHostFor(verified, cfg?.systemDomainId);
  const probe = port25Probe(ctx.activeOrgId);
  const ips = mailNodeIps(ctx);
  const store = await observabilityStore(ctx).catch(() => null);
  setEmailLogStore(ctx.activeOrgId, store);
  const warnings: EmailOverview['warnings'] = [];
  const direct = domains.some((d) => d.delivery !== 'relay');
  if (probe?.verdict === 'blocked' && direct) warnings.push({ id: 'port25', level: 'warn', message: probe.message });
  if (direct && domains.length) {
    warnings.push({
      id: 'fresh-ip',
      level: 'info',
      message:
        `Mail sent directly leaves from ${ips[0] ?? 'the mail node’s IP'}. A fresh IP has no sending reputation, so the first mail often lands in spam: ` +
        'start with low volumes to people who expect it, and set its reverse DNS (PTR) to ' +
        `${helo} at your server provider. For important mail from day one, use a relay.`,
    });
  }
  if (!store) {
    warnings.push({
      id: 'log-store',
      level: 'info',
      message: 'The send log only keeps recent events in memory. Turn on Observability to keep it in ClickHouse.',
    });
  }
  return {
    enabled: Boolean(cfg?.enabled),
    vaultReady: isVaultReady(),
    logBodies: Boolean(cfg?.logBodies),
    systemDomainId: cfg?.systemDomainId ?? null,
    mta: { ...mailServiceStatus(ctx), host: MAIL_HOST, port: SUBMISSION_PORT, helo, nodeIps: ips },
    apiUrl: emailApiUrl(),
    port25: probe ? { ...probe, at: new Date(probe.at).toISOString() } : null,
    warnings,
    logStore: store ? 'clickhouse' : 'memory',
    domains: await Promise.all(domains.map((d) => domainView(ctx, d, helo, cfg?.systemDomainId ?? null))),
    credentials: creds.map(credentialView),
    inboundEnabled: Boolean(cfg?.inboundTokenHash),
  };
}

// ── settings ─────────────────────────────────────────────────────────────────

/** Ensure swarmy's own credential exists (invites, verification, alerts). */
async function ensureSystemCredential(ctx: OrgContext): Promise<void> {
  const existing = await ctx.db.emailCredential.findFirst({ where: { orgId: ctx.activeOrgId, name: SYSTEM_CREDENTIAL } });
  if (existing) return;
  await createCredentialRow(ctx, { name: SYSTEM_CREDENTIAL, domains: [], stack: null });
}

export async function setEmailEnabled(ctx: OrgContext, enabled: boolean): Promise<EmailOverview> {
  if (enabled) requireVault();
  await config(ctx);
  await ctx.db.emailConfig.update({ where: { orgId: ctx.activeOrgId }, data: { enabled } });
  if (enabled) await ensureSystemCredential(ctx);
  await writeAudit(ctx, { action: enabled ? 'email.enable' : 'email.disable', targetType: 'email', targetId: ctx.activeOrgId });
  try {
    await convergeMail(ctx, { force: enabled });
  } catch (e) {
    throw mapDispatchError(e);
  }
  if (enabled) void probePort25(ctx).catch(() => undefined);
  return emailOverview(ctx);
}

export async function setEmailSettings(
  ctx: OrgContext,
  input: { logBodies?: boolean; systemDomainId?: string | null },
): Promise<EmailOverview> {
  await config(ctx);
  if (input.systemDomainId) {
    const d = await ctx.db.emailDomain.findFirst({ where: { id: input.systemDomainId, orgId: ctx.activeOrgId } });
    if (!d) throw notFound('email domain', input.systemDomainId);
  }
  await ctx.db.emailConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      ...(input.logBodies !== undefined ? { logBodies: input.logBodies } : {}),
      ...(input.systemDomainId !== undefined ? { systemDomainId: input.systemDomainId } : {}),
    },
  });
  await writeAudit(ctx, { action: 'email.settings.set', targetType: 'email', metadata: { ...input } });
  await reconverge(ctx);
  return emailOverview(ctx);
}

/** Turn on (rotating) or off the inbound report endpoint; returns the token once. */
export async function setInboundToken(ctx: OrgContext, on: boolean): Promise<{ token: string | null; url: string }> {
  await config(ctx);
  const token = on ? `semin_${newApiKey().slice(4)}` : null;
  await ctx.db.emailConfig.update({ where: { orgId: ctx.activeOrgId }, data: { inboundTokenHash: token ? sha256(token) : null } });
  await writeAudit(ctx, { action: on ? 'email.inbound.rotate' : 'email.inbound.disable', targetType: 'email' });
  return { token, url: `${emailApiUrl()}/inbound` };
}

// ── domains ──────────────────────────────────────────────────────────────────

export interface DomainInput {
  domain: string;
  delivery: 'direct' | 'relay';
  relay?: (RelaySettings & { password?: string | null }) | null;
  dmarcPolicy?: DmarcPolicy;
}

function validateRelay(relay: DomainInput['relay'], delivery: DomainInput['delivery']): RelaySettings | null {
  if (delivery !== 'relay') return null;
  if (!relay?.host) throw badRequest('A relay needs its SMTP host (e.g. smtp.example-provider.com).');
  if (!/^[a-z0-9.-]+$/i.test(relay.host)) throw badRequest(`"${relay.host}" is not a host name`);
  const port = Math.floor(relay.port || 587);
  if (port < 1 || port > 65535) throw badRequest('Relay port must be 1–65535');
  return {
    host: relay.host.toLowerCase(),
    port,
    security: relay.security ?? (port === 465 ? 'tls' : 'starttls'),
    username: relay.username?.trim() || null,
    spfInclude: relay.spfInclude?.trim().toLowerCase() || null,
  };
}

export async function addEmailDomain(ctx: OrgContext, input: DomainInput): Promise<EmailDomainView> {
  requireVault();
  let domain: string;
  try {
    domain = normalizeEmailDomain(input.domain);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const exists = await ctx.db.emailDomain.findFirst({ where: { orgId: ctx.activeOrgId, domain } });
  if (exists) throw badRequest(`${domain} is already set up`);
  const relay = validateRelay(input.relay, input.delivery);
  const key = generateDkimKey();
  const row = await ctx.db.emailDomain.create({
    data: {
      orgId: ctx.activeOrgId,
      domain,
      dkimPrivateKeyEnc: encryptSecret(key.privateKeyPem),
      dkimPublicKey: key.publicKeyB64,
      delivery: input.delivery,
      relay: relay ? (relay as object) : undefined,
      relayPasswordEnc: input.relay?.password ? encryptSecret(input.relay.password) : null,
      dmarcPolicy: input.dmarcPolicy ?? 'none',
    },
  });
  await writeAudit(ctx, { action: 'email.domain.add', targetType: 'email.domain', targetId: row.id, metadata: { domain, delivery: input.delivery } });
  // swarmy-dns zones pick the records up on the next compose (dns-reconcile, 15s) — derived, never stored.
  const helo = await heloFor(ctx);
  const cfg = await ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  return domainView(ctx, row, helo, cfg?.systemDomainId ?? null);
}

export async function updateEmailDomain(
  ctx: OrgContext,
  id: string,
  input: Partial<Omit<DomainInput, 'domain'>>,
): Promise<EmailDomainView> {
  const row = await ctx.db.emailDomain.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email domain', id);
  const delivery = input.delivery ?? (row.delivery === 'relay' ? 'relay' : 'direct');
  const current = relayOf(row.relay);
  const relay = delivery === 'relay' ? validateRelay(input.relay ?? current, delivery) : null;
  if (input.dmarcPolicy && !(DMARC_POLICIES as readonly string[]).includes(input.dmarcPolicy)) throw badRequest('DMARC policy must be none, quarantine or reject');
  const password = input.relay?.password;
  const updated = await ctx.db.emailDomain.update({
    where: { id: row.id },
    data: {
      delivery,
      relay: relay ? (relay as object) : undefined,
      ...(delivery !== 'relay' ? { relay: undefined, relayPasswordEnc: null } : {}),
      ...(password ? { relayPasswordEnc: encryptSecret(password) } : {}),
      ...(input.dmarcPolicy ? { dmarcPolicy: input.dmarcPolicy } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'email.domain.update',
    targetType: 'email.domain',
    targetId: row.id,
    metadata: { domain: row.domain, delivery, relayHost: relay?.host ?? null, passwordChanged: Boolean(password) },
  });
  await reconverge(ctx);
  const cfg = await ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  return domainView(ctx, updated, await heloFor(ctx), cfg?.systemDomainId ?? null);
}

export async function removeEmailDomain(ctx: OrgContext, id: string): Promise<{ ok: true }> {
  const row = await ctx.db.emailDomain.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email domain', id);
  await ctx.db.emailDomain.delete({ where: { id: row.id } });
  await ctx.db.emailConfig.updateMany({ where: { orgId: ctx.activeOrgId, systemDomainId: row.id }, data: { systemDomainId: null } });
  await writeAudit(ctx, { action: 'email.domain.remove', targetType: 'email.domain', targetId: row.id, metadata: { domain: row.domain } });
  await reconverge(ctx);
  return { ok: true };
}

/** Rotate the DKIM key: a new key under a new selector, so mail in flight still verifies. */
export async function rotateDkimKey(ctx: OrgContext, id: string): Promise<EmailDomainView> {
  requireVault();
  const row = await ctx.db.emailDomain.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email domain', id);
  const key = generateDkimKey();
  const selector = `swarmy${Math.floor(Date.now() / 1000).toString(36)}`;
  const updated = await ctx.db.emailDomain.update({
    where: { id: row.id },
    data: { selector, dkimPrivateKeyEnc: encryptSecret(key.privateKeyPem), dkimPublicKey: key.publicKeyB64, verifiedAt: null },
  });
  await writeAudit(ctx, { action: 'email.domain.dkim.rotate', targetType: 'email.domain', targetId: row.id, metadata: { domain: row.domain, selector } });
  await reconverge(ctx);
  const cfg = await ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  return domainView(ctx, updated, await heloFor(ctx), cfg?.systemDomainId ?? null);
}

/** Live resolvers (the system resolver: what receivers will see). */
export const systemDnsLookups = {
  async txt(name: string): Promise<string[]> {
    try {
      return (await dnsPromises.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOTFOUND' || (e as NodeJS.ErrnoException).code === 'ENODATA') return [];
      throw e;
    }
  },
  async addresses(name: string): Promise<string[]> {
    const out: string[] = [];
    for (const fn of [dnsPromises.resolve4, dnsPromises.resolve6]) {
      try {
        out.push(...(await fn(name)));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOTFOUND' && code !== 'ENODATA') throw e;
      }
    }
    return out;
  },
};

/** Check a domain's records now; the DKIM record sets the verification gate. */
export async function checkEmailDomain(ctx: OrgContext, id: string, lookups = systemDnsLookups): Promise<EmailDomainView> {
  const row = await ctx.db.emailDomain.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email domain', id);
  const helo = await heloFor(ctx);
  const check = await checkEmailDns(dnsInput(ctx, row, helo), lookups);
  setDomainCheck(row.id, check);
  let updated = row;
  if (check.dkimOk && !row.verifiedAt) {
    updated = await ctx.db.emailDomain.update({ where: { id: row.id }, data: { verifiedAt: new Date() } });
    await writeAudit(ctx, { action: 'email.domain.verified', targetType: 'email.domain', targetId: row.id, actorType: ctx.user ? 'user' : 'system', metadata: { domain: row.domain } });
    await reconverge(ctx);
  }
  const cfg = await ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  return domainView(ctx, updated, helo, cfg?.systemDomainId ?? null);
}

// ── port 25 ──────────────────────────────────────────────────────────────────

export async function probePort25(ctx: OrgContext): Promise<Port25Probe> {
  const nodeId = mailAgentNodeId(ctx);
  if (!nodeId) throw badRequest('No node is online to probe from.');
  let result: ProbeSmtpResult;
  try {
    result = await ctx.hub.dispatch<ProbeSmtpResult>(nodeId, 'email.probeSmtp', { targets: DEFAULT_SMTP_PROBE_TARGETS, perTargetMs: 6000 });
  } catch (e) {
    throw mapDispatchError(e);
  }
  const probe: Port25Probe = { result, ...interpretSmtpProbe(result), nodeId, at: Date.now() };
  setPort25Probe(ctx.activeOrgId, probe);
  return probe;
}

// ── credentials ──────────────────────────────────────────────────────────────

export interface IssuedCredential {
  credential: EmailCredentialView;
  /** Shown once. */
  smtp: { host: string; port: number; username: string; password: string };
  apiKey: string;
  webhookSecret: string | null;
}

async function createCredentialRow(
  ctx: OrgContext,
  input: { name: string; domains: string[]; stack: string | null; webhookUrl?: string | null },
): Promise<IssuedCredential> {
  const webhookSecret = input.webhookUrl ? newWebhookSecret() : null;
  // Two-step: the SMTP password and API key derive from the row id.
  const row = await ctx.db.emailCredential.create({
    data: {
      orgId: ctx.activeOrgId,
      name: input.name,
      stack: input.stack,
      smtpUsername: smtpUsernameFor(`${input.name}.${ctx.activeOrgId.slice(-6).toLowerCase()}`),
      smtpPasswordHash: 'pending',
      apiKeyHash: `pending-${Math.random().toString(36).slice(2)}`,
      apiKeyPrefix: '',
      domains: input.domains,
      webhookUrl: input.webhookUrl ?? null,
      webhookSecretEnc: webhookSecret ? encryptSecret(webhookSecret) : null,
    },
  });
  const password = smtpPasswordFor(row.id);
  const apiKey = apiKeyFor(row.id);
  const hash = maddyBcrypt(await Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 }));
  const done = await ctx.db.emailCredential.update({
    where: { id: row.id },
    data: { smtpPasswordHash: hash, apiKeyHash: sha256(apiKey), apiKeyPrefix: apiKey.slice(0, 10) },
  });
  return {
    credential: credentialView(done),
    smtp: { host: MAIL_HOST, port: SUBMISSION_PORT, username: done.smtpUsername, password },
    apiKey,
    webhookSecret,
  };
}

function validateWebhookUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('');
    return u.toString();
  } catch {
    throw badRequest('Webhook URL must be an http(s) URL');
  }
}

export async function createEmailCredential(
  ctx: OrgContext,
  input: { name: string; domains?: string[]; webhookUrl?: string | null; stack?: string | null },
): Promise<IssuedCredential> {
  requireVault();
  const name = input.name.trim().toLowerCase();
  if (!CREDENTIAL_NAME_RE.test(name) || name === SYSTEM_CREDENTIAL) throw badRequest('Name: lowercase letters, digits and -, max 40');
  const existing = await ctx.db.emailCredential.findFirst({ where: { orgId: ctx.activeOrgId, name } });
  if (existing) throw badRequest(`A credential named ${name} already exists`);
  const domains = [...new Set((input.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const issued = await createCredentialRow(ctx, { name, domains, stack: input.stack ?? null, webhookUrl: validateWebhookUrl(input.webhookUrl) });
  await writeAudit(ctx, { action: 'email.credential.create', targetType: 'email.credential', targetId: issued.credential.id, metadata: { name, domains } });
  await reconverge(ctx);
  return issued;
}

export async function updateEmailCredential(
  ctx: OrgContext,
  id: string,
  input: { domains?: string[]; webhookUrl?: string | null; disabled?: boolean },
): Promise<{ credential: EmailCredentialView; webhookSecret: string | null }> {
  const row = await ctx.db.emailCredential.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email credential', id);
  const webhookUrl = input.webhookUrl === undefined ? undefined : validateWebhookUrl(input.webhookUrl);
  const newSecret = webhookUrl && webhookUrl !== row.webhookUrl ? newWebhookSecret() : null;
  const updated = await ctx.db.emailCredential.update({
    where: { id: row.id },
    data: {
      ...(input.domains ? { domains: [...new Set(input.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))] } : {}),
      ...(webhookUrl !== undefined ? { webhookUrl, ...(webhookUrl ? {} : { webhookSecretEnc: null }) } : {}),
      ...(newSecret ? { webhookSecretEnc: encryptSecret(newSecret) } : {}),
      ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'email.credential.update',
    targetType: 'email.credential',
    targetId: row.id,
    metadata: { name: row.name, domains: input.domains, webhook: webhookUrl !== undefined ? Boolean(webhookUrl) : undefined, disabled: input.disabled },
  });
  await reconverge(ctx);
  return { credential: credentialView(updated), webhookSecret: newSecret };
}

export async function removeEmailCredential(ctx: OrgContext, id: string): Promise<{ ok: true }> {
  const row = await ctx.db.emailCredential.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email credential', id);
  if (row.name === SYSTEM_CREDENTIAL) throw badRequest('swarmy’s own credential sends invites and alerts; turn the email service off instead.');
  await ctx.db.emailCredential.delete({ where: { id: row.id } });
  await writeAudit(ctx, { action: 'email.credential.remove', targetType: 'email.credential', targetId: row.id, metadata: { name: row.name } });
  await reconverge(ctx);
  return { ok: true };
}

/** Read an SMTP password + API key back (both derived). Gated on `secrets.read` at the router. */
export async function revealEmailCredential(ctx: OrgContext, id: string): Promise<{ username: string; password: string; apiKey: string }> {
  requireVault();
  const row = await ctx.db.emailCredential.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email credential', id);
  await writeAudit(ctx, { action: 'email.credential.reveal', targetType: 'email.credential', targetId: row.id, metadata: { name: row.name } });
  return { username: row.smtpUsername, password: smtpPasswordFor(row.id), apiKey: apiKeyFor(row.id) };
}

// ── templates ────────────────────────────────────────────────────────────────

const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export async function listEmailTemplates(ctx: OrgContext) {
  const rows = await ctx.db.emailTemplate.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { name: 'asc' } });
  return rows.map((t) => ({ id: t.id, name: t.name, subject: t.subject, html: t.html, text: t.text, updatedAt: t.updatedAt.toISOString() }));
}

export async function saveEmailTemplate(
  ctx: OrgContext,
  input: { name: string; subject: string; html?: string | null; text?: string | null },
) {
  const name = input.name.trim().toLowerCase();
  if (!TEMPLATE_NAME_RE.test(name)) throw badRequest('Template name: lowercase letters, digits, - and _');
  if (!input.subject.trim()) throw badRequest('A template needs a subject');
  if (!input.html?.trim() && !input.text?.trim()) throw badRequest('A template needs an HTML or text body');
  const data = { subject: input.subject, html: input.html?.trim() ? input.html : null, text: input.text?.trim() ? input.text : null };
  const row = await ctx.db.emailTemplate.upsert({
    where: { orgId_name: { orgId: ctx.activeOrgId, name } },
    create: { orgId: ctx.activeOrgId, name, ...data },
    update: data,
  });
  await writeAudit(ctx, { action: 'email.template.save', targetType: 'email.template', targetId: row.id, metadata: { name } });
  return { id: row.id, name: row.name };
}

export async function removeEmailTemplate(ctx: OrgContext, id: string): Promise<{ ok: true }> {
  const row = await ctx.db.emailTemplate.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('email template', id);
  await ctx.db.emailTemplate.delete({ where: { id: row.id } });
  await writeAudit(ctx, { action: 'email.template.remove', targetType: 'email.template', targetId: row.id, metadata: { name: row.name } });
  return { ok: true };
}

// ── suppressions ─────────────────────────────────────────────────────────────

export async function listSuppressions(ctx: OrgContext, q: { search?: string; limit?: number } = {}) {
  const rows = await ctx.db.emailSuppression.findMany({
    where: { orgId: ctx.activeOrgId, ...(q.search ? { address: { contains: q.search.toLowerCase() } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, q.limit ?? 200)),
  });
  return rows.map((s) => ({ id: s.id, address: s.address, reason: s.reason, detail: s.detail, credentialId: s.credentialId, createdAt: s.createdAt.toISOString() }));
}

export async function addSuppression(ctx: OrgContext, address: string): Promise<{ ok: true }> {
  const a = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw badRequest(`"${address}" is not an email address`);
  await ctx.db.emailSuppression.upsert({
    where: { orgId_address: { orgId: ctx.activeOrgId, address: a } },
    create: { orgId: ctx.activeOrgId, address: a, reason: 'manual' },
    update: {},
  });
  await writeAudit(ctx, { action: 'email.suppression.add', targetType: 'email.suppression', metadata: { address: a } });
  await reconverge(ctx);
  return { ok: true };
}

export async function removeSuppression(ctx: OrgContext, id: string): Promise<{ ok: true }> {
  const row = await ctx.db.emailSuppression.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('suppression', id);
  await ctx.db.emailSuppression.delete({ where: { id: row.id } });
  await writeAudit(ctx, { action: 'email.suppression.remove', targetType: 'email.suppression', metadata: { address: row.address, reason: row.reason } });
  await reconverge(ctx);
  return { ok: true };
}

// ── send log + test send ─────────────────────────────────────────────────────

export async function emailSendLog(ctx: OrgContext, q: EmailLogQuery): Promise<EmailLogPage> {
  if (!emailLogStoreOf(ctx.activeOrgId)) setEmailLogStore(ctx.activeOrgId, await observabilityStore(ctx).catch(() => null));
  return readEmailLog(ctx.activeOrgId, q);
}

/** Send a short test message through the real path (MTA, DKIM, delivery route). */
export async function sendTestEmail(ctx: OrgContext, input: { from: string; to: string }): Promise<{ messageId: string; response: string }> {
  const system = await ctx.db.emailCredential.findFirst({ where: { orgId: ctx.activeOrgId, name: SYSTEM_CREDENTIAL } });
  if (!system) throw badRequest('Turn the email service on first.');
  const res = await sendAsCredential(ctx.db, system, {
    from: input.from,
    to: [input.to],
    subject: 'swarmy test email',
    text:
      'This is a test email from swarmy.\n\nIf it reached your inbox, the domain’s DKIM signature and delivery path work. ' +
      'If it landed in spam, check the SPF and DMARC records on the Email page and consider a relay.',
    source: 'api',
  });
  await writeAudit(ctx, { action: 'email.test.send', targetType: 'email', metadata: { from: input.from, to: input.to, messageId: res.messageId } });
  return { messageId: res.messageId, response: res.response };
}

// ── used by the app (swarmy.yaml) binding path ───────────────────────────────

/**
 * The credential an app's `email:` block binds to — minted on first apply,
 * reused after. Returns the SMTP password + API key material the apply path
 * puts in the app's Docker secrets (derived / recreated, never stored plain).
 */
export async function ensureAppEmailCredential(
  ctx: OrgContext,
  stack: string,
  from: string | null,
): Promise<{ username: string; password: string; apiKey: string; from: string; credentialId: string }> {
  requireVault();
  const cfg = await ctx.db.emailConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  if (!cfg?.enabled) throw badRequest('swarmy.yaml asks for email, but the email service is off. Turn it on under Email.');
  const verified = await ctx.db.emailDomain.findMany({ where: { orgId: ctx.activeOrgId, verifiedAt: { not: null } }, orderBy: { domain: 'asc' } });
  const sys = verified.find((d) => d.id === cfg.systemDomainId) ?? verified[0];
  const address = from ?? (sys ? `noreply@${sys.domain}` : null);
  if (!address) throw badRequest('swarmy.yaml asks for email, but no sending domain is verified yet.');
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (!verified.some((d) => d.domain === domain)) throw badRequest(`email.from uses ${domain}, which is not a verified sending domain.`);
  const name = `app-${stack}`.slice(0, 40);
  const existing = await ctx.db.emailCredential.findFirst({ where: { orgId: ctx.activeOrgId, name } });
  if (existing) {
    const allowed = domainsOf(existing.domains);
    if (allowed.length && !allowed.includes(domain)) {
      await ctx.db.emailCredential.update({ where: { id: existing.id }, data: { domains: [...allowed, domain] } });
      await reconverge(ctx);
    }
    return { username: existing.smtpUsername, password: smtpPasswordFor(existing.id), apiKey: apiKeyFor(existing.id), from: address, credentialId: existing.id };
  }
  const issued = await createCredentialRow(ctx, { name, domains: [domain], stack });
  await writeAudit(ctx, { action: 'email.credential.create', targetType: 'email.credential', targetId: issued.credential.id, actorType: 'system', metadata: { name, stack, domains: [domain] } });
  await reconverge(ctx);
  return { username: issued.smtp.username, password: issued.smtp.password, apiKey: issued.apiKey, from: address, credentialId: issued.credential.id };
}
