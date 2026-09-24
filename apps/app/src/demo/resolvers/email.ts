import type { DemoStore, DomainResolvers } from '../types';

/**
 * Email-service demo resolvers (`/email`): one verified domain on swarmy DNS,
 * one pending external domain, two credentials, a template, a short send log
 * and one suppressed address. Shapes mirror email.service.ts views.
 */

const API_URL = 'https://controller.demo.swarmy.dev/email/v1';
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxKLxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo9z+40RQzuVaE8AkAFmxZzow3x+VJYKdjykkJ0iT9wCS0DRTXu269V264Vf/3jvredZiKRkgwlL9xNAwxXFg0x/XFw005UWVRIkdgcKWTjpBP2dPwVZ4WWC+9aGVd+Gyn1o0CLelf4rEjGoXbAAEgAqeGUxrcIlbjXfbcmwIDAQAB';

interface EmailDemoState {
  enabled: boolean;
  logBodies: boolean;
  domains: Array<Record<string, unknown>>;
  credentials: Array<Record<string, unknown>>;
  templates: Array<{ id: string; name: string; subject: string; html: string | null; text: string | null; updatedAt: string }>;
  suppressions: Array<{ id: string; address: string; reason: string; detail: string | null; credentialId: string | null; createdAt: string }>;
  log: Array<Record<string, unknown>>;
}

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

function records(domain: string, ok: boolean) {
  const base = [
    { kind: 'dkim', name: `swarmy._domainkey.${domain}`, type: 'TXT', value: `v=DKIM1; k=rsa; p=${KEY}`, required: true, purpose: 'Proves mail signed by swarmy really comes from this domain.' },
    { kind: 'spf', name: domain, type: 'TXT', value: 'v=spf1 ip4:203.0.113.7 ~all', required: false, purpose: 'Lists the mail node’s IP as allowed to send for this domain.' },
    { kind: 'dmarc', name: `_dmarc.${domain}`, type: 'TXT', value: 'v=DMARC1; p=none; adkim=r; aspf=r', required: false, purpose: 'Tells receivers what to do with mail that fails SPF and DKIM.' },
  ];
  return base.map((r) => ({ ...r, status: ok ? 'ok' : 'missing', found: ok ? [r.value] : [], ...(ok ? {} : { hint: `Add a TXT record at ${r.name} with the value shown.` }) }));
}

function seed(store: DemoStore): void {
  const state: EmailDemoState = {
    enabled: true,
    logBodies: false,
    domains: [
      { id: 'ed1', domain: 'acme.dev', selector: 'swarmy', delivery: 'direct', relay: null, dmarcPolicy: 'none', verifiedAt: ago(4000), dns: { mode: 'swarmy', zone: 'acme.dev', delegated: true }, records: records('acme.dev', true), checkedAt: ago(3), isSystem: true },
      { id: 'ed2', domain: 'shop.example.com', selector: 'swarmy', delivery: 'relay', relay: { host: 'smtp.relay.example', port: 587, security: 'starttls', username: 'shop', spfInclude: 'spf.relay.example', passwordSet: true }, dmarcPolicy: 'none', verifiedAt: null, dns: { mode: 'external', zone: null, delegated: false }, records: records('shop.example.com', false), checkedAt: ago(1), isSystem: false },
    ],
    credentials: [
      { id: 'ec0', name: 'swarmy-system', stack: null, smtpUsername: 'swarmy-system.demo01@swarmy', apiKeyPrefix: 'sem_4f9Qa', domains: [], webhookUrl: null, disabled: false, system: true, createdAt: ago(5000) },
      { id: 'ec1', name: 'app-shop', stack: 'shop', smtpUsername: 'app-shop.demo01@swarmy', apiKeyPrefix: 'sem_Zk31p', domains: ['acme.dev'], webhookUrl: 'https://shop.acme.dev/hooks/email', disabled: false, system: false, createdAt: ago(3000) },
    ],
    templates: [{ id: 'et1', name: 'welcome', subject: 'Welcome, {{ name }}', html: '<p>Hi {{ name }}, thanks for joining.</p>', text: null, updatedAt: ago(900) }],
    suppressions: [{ id: 'es1', address: 'gone@example.org', reason: 'bounce', detail: 'smtp; 550 5.1.1 user unknown', credentialId: 'ec1', createdAt: ago(120) }],
    log: [
      { ts: ago(2), event: 'delivered', mtaId: '161c8b61', messageId: '<a1@acme.dev>', credential: 'app-shop.demo01@swarmy', sender: 'hello@acme.dev', rcpt: 'ada@example.com', domain: 'acme.dev', subject: 'Welcome, Ada', smtpCode: 0, detail: '', source: 'smtp' },
      { ts: ago(3), event: 'queued', mtaId: '', messageId: '<a1@acme.dev>', credential: 'app-shop.demo01@swarmy', sender: 'hello@acme.dev', rcpt: 'ada@example.com', domain: 'acme.dev', subject: 'Welcome, Ada', smtpCode: 0, detail: '', source: 'api' },
      { ts: ago(120), event: 'bounced', mtaId: '8eb7b1fd', messageId: '<b2@acme.dev>', credential: 'app-shop.demo01@swarmy', sender: 'hello@acme.dev', rcpt: 'gone@example.org', domain: 'acme.dev', subject: 'Your receipt', smtpCode: 550, detail: 'smtp; 550 5.1.1 user unknown', source: 'report' },
    ],
  };
  store.extra.email = state;
}

const st = (s: DemoStore): EmailDemoState => s.extra.email as EmailDemoState;

function overview(s: DemoStore) {
  const e = st(s);
  return {
    enabled: e.enabled,
    vaultReady: true,
    logBodies: e.logBodies,
    systemDomainId: 'ed1',
    mta: { deployed: e.enabled, running: e.enabled, desired: 1, image: 'foxcpp/maddy:0.9.5', host: 'swarmy-mail', port: 587, helo: 'mail.acme.dev', nodeIps: ['203.0.113.7'] },
    apiUrl: API_URL,
    port25: { result: { attempts: [], reachable: true }, verdict: 'open', message: 'Outbound port 25 is open: the mail node can deliver directly.', nodeId: 'n1', at: ago(30) },
    warnings: [
      { id: 'fresh-ip', level: 'info', message: 'Mail sent directly leaves from 203.0.113.7. A fresh IP has no sending reputation, so start with low volumes and set its reverse DNS (PTR) to mail.acme.dev.' },
    ],
    logStore: 'clickhouse',
    domains: e.domains,
    credentials: e.credentials,
    inboundEnabled: false,
  };
}

const ok = { ok: true };

export const email: DomainResolvers = {
  seed,
  handlers: {
    'email.overview': (_i, s) => overview(s),
    'email.setEnabled': (i, s) => {
      st(s).enabled = (i as { enabled: boolean }).enabled;
      return overview(s);
    },
    'email.setSettings': (i, s) => {
      const b = i as { logBodies?: boolean };
      if (b.logBodies !== undefined) st(s).logBodies = b.logBodies;
      return overview(s);
    },
    'email.setInbound': (i) => ({ token: (i as { enabled: boolean }).enabled ? 'semin_demoToken' : null, url: `${API_URL}/inbound` }),
    'email.checkDomain': (i, s) => st(s).domains.find((d) => d.id === (i as { id: string }).id),
    'email.probePort25': () => ({ result: { attempts: [], reachable: true }, verdict: 'open', message: 'Outbound port 25 is open.', nodeId: 'n1', at: Date.now() }),
    'email.addDomain': (i, s) => {
      const b = i as { domain: string; delivery: string };
      const d = { id: `ed${Date.now()}`, domain: b.domain.toLowerCase(), selector: 'swarmy', delivery: b.delivery, relay: null, dmarcPolicy: 'none', verifiedAt: null, dns: { mode: 'external', zone: null, delegated: false }, records: records(b.domain.toLowerCase(), false), checkedAt: null, isSystem: false };
      st(s).domains.push(d);
      return d;
    },
    'email.updateDomain': (i, s) => st(s).domains.find((d) => d.id === (i as { id: string }).id),
    'email.rotateDkim': (i, s) => st(s).domains.find((d) => d.id === (i as { id: string }).id),
    'email.removeDomain': (i, s) => {
      st(s).domains = st(s).domains.filter((d) => d.id !== (i as { id: string }).id);
      return ok;
    },
    'email.createCredential': (i, s) => {
      const b = i as { name: string; domains?: string[]; webhookUrl?: string | null };
      const c = { id: `ec${Date.now()}`, name: b.name, stack: null, smtpUsername: `${b.name}.demo01@swarmy`, apiKeyPrefix: 'sem_Demo1', domains: b.domains ?? [], webhookUrl: b.webhookUrl ?? null, disabled: false, system: false, createdAt: new Date().toISOString() };
      st(s).credentials.push(c);
      return { credential: c, smtp: { host: 'swarmy-mail', port: 587, username: c.smtpUsername, password: 'demo-smtp-password-0123456789ab' }, apiKey: 'sem_demoApiKey', webhookSecret: b.webhookUrl ? 'whsec_demo' : null };
    },
    'email.updateCredential': (i, s) => ({ credential: st(s).credentials.find((c) => c.id === (i as { id: string }).id), webhookSecret: null }),
    'email.removeCredential': (i, s) => {
      st(s).credentials = st(s).credentials.filter((c) => c.id !== (i as { id: string }).id);
      return ok;
    },
    'email.revealCredential': (i, s) => {
      const c = st(s).credentials.find((x) => x.id === (i as { id: string }).id);
      return { username: String(c?.smtpUsername ?? ''), password: 'demo-smtp-password-0123456789ab', apiKey: 'sem_demoApiKey' };
    },
    'email.templates': (_i, s) => st(s).templates,
    'email.saveTemplate': (i, s) => {
      const b = i as { name: string; subject: string; html?: string | null; text?: string | null };
      const e = st(s);
      const t = { id: `et${Date.now()}`, name: b.name, subject: b.subject, html: b.html ?? null, text: b.text ?? null, updatedAt: new Date().toISOString() };
      e.templates = [...e.templates.filter((x) => x.name !== b.name), t];
      return { id: t.id, name: t.name };
    },
    'email.removeTemplate': (i, s) => {
      st(s).templates = st(s).templates.filter((t) => t.id !== (i as { id: string }).id);
      return ok;
    },
    'email.suppressions': (_i, s) => st(s).suppressions,
    'email.addSuppression': (i, s) => {
      st(s).suppressions.unshift({ id: `es${Date.now()}`, address: (i as { address: string }).address.toLowerCase(), reason: 'manual', detail: null, credentialId: null, createdAt: new Date().toISOString() });
      return ok;
    },
    'email.removeSuppression': (i, s) => {
      st(s).suppressions = st(s).suppressions.filter((x) => x.id !== (i as { id: string }).id);
      return ok;
    },
    'email.log': (_i, s) => ({ items: st(s).log, source: 'clickhouse', storeError: null }),
    'email.testSend': () => ({ messageId: '<demo-test@acme.dev>', response: '250 2.0.0 OK: queued' }),
  },
};
