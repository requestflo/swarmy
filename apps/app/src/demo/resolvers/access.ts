import { DEMO_USER } from '../data';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Access & identity demo resolvers — the Access Control surface (members + ABAC
 * attributes, ReBAC grants, sign-in providers, enterprise SSO, ABAC policies) and
 * the public-API credentials surface (API keys + OAuth client-credentials).
 *
 * Every collection lives under `store.extra.access` and is seeded from the demo
 * cluster (Northwind org, `svc-*` / `n-*` resource ids) so the tables read as a
 * coherent, lived-in org. Mutations write back into that bag so the UI — which
 * invalidates and re-reads on success — reflects changes live within the session.
 *
 * Return shapes mirror the tRPC service views exactly (members.service /
 * apiKeys.service / oauth.service / authConfig.service / sso.service /
 * policies.service) so the dashboard pages render unchanged.
 */

// ── View shapes (kept in lock-step with the @swarmy/* service views) ──────────

interface MemberView {
  id: string;
  role: 'owner' | 'admin' | 'member';
  user: { id: string; name: string | null; email: string | null };
  attributes: Record<string, unknown>;
}

interface OrgMemberView {
  id: string;
  role: string;
  user: { id: string; name: string | null; email: string | null; image: string | null };
  joinedAt: string;
}

interface GrantView {
  id: string;
  principalType: 'member' | 'team';
  principalId: string;
  resourceType: string;
  resourceId: string;
  relation: 'owner' | 'operator' | 'viewer';
}

type ApiKeyScope = 'read' | 'write';

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  createdAt: string;
  createdById: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked';
}

type OAuthScope = 'read' | 'write';

interface OAuthClientView {
  id: string;
  name: string;
  clientId: string;
  scopes: OAuthScope[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  status: 'active' | 'revoked';
}

type ProviderKind = 'social' | 'method';

interface ProviderListEntry {
  type: string;
  kind: ProviderKind;
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  scopes: string[];
  callbackUrl: string;
}

interface SsoProviderView {
  id: string;
  providerId: string;
  protocol: 'oidc' | 'saml';
  domain: string | null;
  issuer: string | null;
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  mapping: Record<string, string>;
  callbackUrl: string;
  loginUrl: string;
}

interface PolicyView {
  id: string;
  name: string;
  description: string | null;
  effect: 'permit' | 'forbid';
  source: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: string;
}

/** The free-form bag this module owns under `store.extra.access`. */
interface AccessState {
  members: MemberView[];
  grants: GrantView[];
  apiKeys: ApiKeyView[];
  oauthClients: OAuthClientView[];
  providers: ProviderListEntry[];
  sso: SsoProviderView[];
  policies: PolicyView[];
}

// ── Constants mirrored from the services ──────────────────────────────────────

/** The complete governed-action catalogue (packages/abac ACTIONS). */
const ACTIONS = [
  'node.read',
  'node.drain',
  'node.remove',
  'node.setLabels',
  'service.read',
  'service.deploy',
  'service.scale',
  'service.restart',
  'service.remove',
  'stack.read',
  'stack.deploy',
  'stack.remove',
  'ingress.read',
  'ingress.write',
  'token.create',
  'token.revoke',
  'policy.read',
  'policy.write',
  'member.read',
  'member.write',
  'authconfig.read',
  'authconfig.write',
  'terminal.open',
] as const;

const SOCIAL_PROVIDERS = ['github', 'google'] as const;
const AUTH_METHODS = ['passkey', 'magic_link'] as const;

/** Demo controller origin used for callback/login URLs in the UI. */
const CALLBACK_BASE = 'https://demo.swarmy.dev';

function callbackUrl(type: string): string {
  return `${CALLBACK_BASE}/api/auth/callback/${type}`;
}
function ssoCallbackUrl(providerId: string): string {
  return `${CALLBACK_BASE}/api/auth/oauth2/callback/${providerId}`;
}
function ssoLoginUrl(providerId: string): string {
  return `${CALLBACK_BASE}/api/auth/sign-in/oauth2/${providerId}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rid = (n = 6): string => Math.random().toString(36).slice(2, 2 + n);
const hex = (n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

function state(store: DemoStore): AccessState {
  return store.extra.access as AccessState;
}

// ── Seed: a believable Northwind access posture ───────────────────────────────

function seedMembers(): MemberView[] {
  return [
    {
      id: 'mem-owner',
      role: 'owner',
      user: { id: DEMO_USER.id, name: DEMO_USER.name, email: DEMO_USER.email },
      attributes: { team: 'platform', employment: 'full-time', onCall: true },
    },
    {
      id: 'mem-ada',
      role: 'admin',
      user: { id: 'user-ada', name: 'Ada Okafor', email: 'ada@northwind.dev' },
      attributes: { team: 'platform', employment: 'full-time', onCall: false },
    },
    {
      id: 'mem-bruno',
      role: 'member',
      user: { id: 'user-bruno', name: 'Bruno Costa', email: 'bruno@northwind.dev' },
      attributes: { team: 'payments', employment: 'full-time', teamIds: ['team-payments'] },
    },
    {
      id: 'mem-mei',
      role: 'member',
      user: { id: 'user-mei', name: 'Mei Tanaka', email: 'mei@northwind.dev' },
      attributes: { team: 'storefront', employment: 'contractor', teamIds: ['team-storefront'] },
    },
    {
      id: 'mem-omar',
      role: 'member',
      user: { id: 'user-omar', name: 'Omar Haddad', email: 'omar@northwind.dev' },
      attributes: { team: 'data', employment: 'full-time', onCall: true, teamIds: ['team-data'] },
    },
  ];
}

function seedGrants(): GrantView[] {
  return [
    {
      id: 'grant-1',
      principalType: 'member',
      principalId: 'mem-bruno',
      resourceType: 'service',
      resourceId: 'svc-checkout',
      relation: 'operator',
    },
    {
      id: 'grant-2',
      principalType: 'team',
      principalId: 'team-storefront',
      resourceType: 'stack',
      resourceId: 's-store',
      relation: 'operator',
    },
    {
      id: 'grant-3',
      principalType: 'member',
      principalId: 'mem-omar',
      resourceType: 'service',
      resourceId: 'svc-postgres',
      relation: 'owner',
    },
    {
      id: 'grant-4',
      principalType: 'member',
      principalId: 'mem-mei',
      resourceType: 'node',
      resourceId: 'n-wkr-2',
      relation: 'viewer',
    },
  ];
}

function seedApiKeys(): ApiKeyView[] {
  return [
    {
      id: 'key-ci',
      name: 'ci-terraform',
      prefix: hex(8),
      scopes: ['read', 'write'],
      lastUsedAt: iso(12 * MIN),
      createdAt: iso(40 * DAY),
      createdById: DEMO_USER.id,
      revokedAt: null,
      status: 'active',
    },
    {
      id: 'key-grafana',
      name: 'grafana-readonly',
      prefix: hex(8),
      scopes: ['read'],
      lastUsedAt: iso(2 * HOUR),
      createdAt: iso(18 * DAY),
      createdById: 'user-ada',
      revokedAt: null,
      status: 'active',
    },
    {
      id: 'key-backup',
      name: 'nightly-backup',
      prefix: hex(8),
      scopes: ['read', 'write'],
      lastUsedAt: iso(9 * HOUR),
      createdAt: iso(63 * DAY),
      createdById: DEMO_USER.id,
      revokedAt: null,
      status: 'active',
    },
    {
      id: 'key-laptop',
      name: 'omar-laptop',
      prefix: hex(8),
      scopes: ['read'],
      lastUsedAt: null,
      createdAt: iso(90 * DAY),
      createdById: 'user-omar',
      revokedAt: iso(5 * DAY),
      status: 'revoked',
    },
  ];
}

function seedOAuthClients(): OAuthClientView[] {
  return [
    {
      id: 'oac-tf',
      name: 'terraform-ci',
      clientId: `swc_${hex(24)}`,
      scopes: ['read', 'write'],
      lastUsedAt: iso(34 * MIN),
      createdAt: iso(22 * DAY),
      revokedAt: null,
      status: 'active',
    },
    {
      id: 'oac-deploybot',
      name: 'deploy-bot',
      clientId: `swc_${hex(24)}`,
      scopes: ['read', 'write'],
      lastUsedAt: iso(3 * HOUR),
      createdAt: iso(47 * DAY),
      revokedAt: null,
      status: 'active',
    },
    {
      id: 'oac-statuspage',
      name: 'statuspage-poller',
      clientId: `swc_${hex(24)}`,
      scopes: ['read'],
      lastUsedAt: iso(6 * MIN),
      createdAt: iso(11 * DAY),
      revokedAt: null,
      status: 'active',
    },
    {
      id: 'oac-legacy',
      name: 'legacy-importer',
      clientId: `swc_${hex(24)}`,
      scopes: ['read'],
      lastUsedAt: iso(70 * DAY),
      createdAt: iso(120 * DAY),
      revokedAt: iso(30 * DAY),
      status: 'revoked',
    },
  ];
}

function seedProviders(): ProviderListEntry[] {
  const social: ProviderListEntry[] = SOCIAL_PROVIDERS.map((type) => {
    const configured = type === 'github';
    return {
      type,
      kind: 'social',
      enabled: configured,
      clientId: configured ? `Iv1.${hex(16)}` : null,
      hasSecret: configured,
      scopes: configured ? ['read:user', 'user:email'] : [],
      callbackUrl: callbackUrl(type),
    };
  });
  const methods: ProviderListEntry[] = AUTH_METHODS.map((type) => ({
    type,
    kind: 'method',
    enabled: type === 'passkey',
    clientId: null,
    hasSecret: false,
    scopes: [],
    callbackUrl: '',
  }));
  return [...social, ...methods];
}

function seedSso(): SsoProviderView[] {
  return [
    {
      id: 'sso-acme',
      providerId: 'acme',
      protocol: 'oidc',
      domain: 'acme.com',
      issuer: 'https://idp.acme.com',
      clientId: `acme-${hex(8)}`,
      hasSecret: true,
      enabled: true,
      metadata: { discoveryUrl: 'https://idp.acme.com/.well-known/openid-configuration' },
      mapping: { email: 'email', name: 'name', team: 'department' },
      callbackUrl: ssoCallbackUrl('acme'),
      loginUrl: ssoLoginUrl('acme'),
    },
    {
      id: 'sso-globex',
      providerId: 'globex',
      protocol: 'saml',
      domain: 'globex.io',
      issuer: null,
      clientId: null,
      hasSecret: true,
      enabled: false,
      metadata: { entityId: 'https://sso.globex.io/saml/metadata' },
      mapping: {},
      callbackUrl: ssoCallbackUrl('globex'),
      loginUrl: ssoLoginUrl('globex'),
    },
  ];
}

function seedPolicies(): PolicyView[] {
  const defaults: Array<{ name: string; effect: 'permit' | 'forbid'; priority: number; doc: unknown }> = [
    { name: 'Owners can do anything', effect: 'permit', priority: 100, doc: { roles: ['owner'], actions: ['*'] } },
    { name: 'Admins can do anything', effect: 'permit', priority: 90, doc: { roles: ['admin'], actions: ['*'] } },
    {
      name: 'Members can read',
      effect: 'permit',
      priority: 50,
      doc: {
        roles: ['member'],
        actions: ['node.read', 'service.read', 'stack.read', 'ingress.read', 'member.read', 'policy.read', 'authconfig.read'],
      },
    },
    {
      name: 'Resource operators can operate their resources',
      effect: 'permit',
      priority: 45,
      doc: {
        relations: ['operator', 'owner'],
        actions: ['service.deploy', 'service.scale', 'service.restart', 'stack.deploy', 'node.drain'],
      },
    },
    {
      name: 'Members can run safe operations',
      effect: 'permit',
      priority: 40,
      doc: {
        roles: ['member'],
        actions: ['node.drain', 'node.setLabels', 'service.deploy', 'service.scale', 'service.restart', 'stack.deploy', 'ingress.write'],
      },
    },
  ];

  const defaultRows: PolicyView[] = defaults.map((p, i) => ({
    id: `pol-default-${i}`,
    name: p.name,
    description: null,
    effect: p.effect,
    source: JSON.stringify(p.doc, null, 2),
    priority: p.priority,
    enabled: true,
    isDefault: true,
    updatedAt: iso(30 * DAY),
  }));

  const custom: PolicyView[] = [
    {
      id: 'pol-oncall-restart',
      name: 'On-call may restart payments',
      description: 'Let the on-call rotation restart payment services out of hours.',
      effect: 'permit',
      priority: 60,
      source: JSON.stringify(
        { attributes: { onCall: true }, resourceLabels: { team: 'payments' }, actions: ['service.restart'] },
        null,
        2,
      ),
      enabled: true,
      isDefault: false,
      updatedAt: iso(3 * DAY),
    },
    {
      id: 'pol-freeze-prod',
      name: 'Freeze production removals',
      description: 'No one but owners removes production services.',
      effect: 'forbid',
      priority: 80,
      source: JSON.stringify(
        { roles: ['admin', 'member'], resourceLabels: { env: 'production' }, actions: ['service.remove', 'stack.remove'] },
        null,
        2,
      ),
      enabled: true,
      isDefault: false,
      updatedAt: iso(8 * HOUR),
    },
    {
      id: 'pol-contractor-readonly',
      name: 'Contractors are read-only',
      description: 'Contractors cannot mutate the cluster.',
      effect: 'forbid',
      priority: 70,
      source: JSON.stringify(
        { attributes: { employment: 'contractor' }, actions: ['service.deploy', 'service.scale', 'service.remove', 'stack.deploy'] },
        null,
        2,
      ),
      enabled: false,
      isDefault: false,
      updatedAt: iso(40 * MIN),
    },
  ];

  // Mirrors the service ordering: priority desc, then creation order.
  return [...defaultRows, ...custom].sort((a, b) => b.priority - a.priority);
}

// ── Policy source parsing (mirrors abac parsePolicyDoc, just enough) ──────────

const POLICY_KEYS = new Set([
  'actions',
  'roles',
  'resourceTypes',
  'resourceLabels',
  'attributes',
  'ownerOnly',
  'relations',
]);

function validateSource(source: string): { valid: boolean; error?: string; doc?: unknown } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { valid: false, error: 'source is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'policy must be a JSON object' };
  }
  const doc = raw as Record<string, unknown>;
  const unknownKey = Object.keys(doc).find((k) => !POLICY_KEYS.has(k));
  if (unknownKey) return { valid: false, error: `unknown clause "${unknownKey}"` };
  if (Object.keys(doc).length === 0) return { valid: false, error: 'policy has no clauses' };
  return { valid: true, doc };
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

export const access: DomainResolvers = {
  seed(store) {
    const s: AccessState = {
      members: seedMembers(),
      grants: seedGrants(),
      apiKeys: seedApiKeys(),
      oauthClients: seedOAuthClients(),
      providers: seedProviders(),
      sso: seedSso(),
      policies: seedPolicies(),
    };
    store.extra.access = s;
  },

  handlers: {
    // ── members ──────────────────────────────────────────────────────────────
    'members.list': (_i, store): MemberView[] => state(store).members,

    'members.setAttributes': (input, store): MemberView => {
      const { memberId, attributes } = input as { memberId: string; attributes: Record<string, unknown> };
      const s = state(store);
      const m = s.members.find((x) => x.id === memberId);
      if (!m) throw new Error(`member "${memberId}" not found`);
      m.attributes = attributes;
      return m;
    },

    'members.listGrants': (_i, store): GrantView[] => state(store).grants,

    'members.createGrant': (input, store): GrantView => {
      const args = input as {
        principalType: 'member' | 'team';
        principalId: string;
        resourceType: 'node' | 'service' | 'stack';
        resourceId: string;
        relation: 'owner' | 'operator' | 'viewer';
      };
      const s = state(store);
      const existing = s.grants.find(
        (g) =>
          g.principalType === args.principalType &&
          g.principalId === args.principalId &&
          g.resourceType === args.resourceType &&
          g.resourceId === args.resourceId &&
          g.relation === args.relation,
      );
      if (existing) return existing;
      const row: GrantView = { id: `grant-${rid()}`, ...args };
      s.grants.push(row);
      return row;
    },

    'members.deleteGrant': (input, store): { id: string; deleted: true } => {
      const { id } = input as { id: string };
      const s = state(store);
      s.grants = s.grants.filter((g) => g.id !== id);
      return { id, deleted: true };
    },

    // ── org.members (settings → members) ───────────────────────────────────────
    'org.members': (_i, store): OrgMemberView[] =>
      state(store).members.map((m, idx) => ({
        id: m.id,
        role: m.role,
        user: { id: m.user.id, name: m.user.name, email: m.user.email, image: null },
        joinedAt: iso((30 - idx * 4) * DAY),
      })),

    // ── apiKeys ────────────────────────────────────────────────────────────────
    'apiKeys.list': (_i, store): ApiKeyView[] => state(store).apiKeys,

    'apiKeys.create': (input, store) => {
      const b = input as { name: string; scopes?: ApiKeyScope[] };
      const scopes = b.scopes && b.scopes.length ? b.scopes : (['read'] as ApiKeyScope[]);
      const prefix = hex(8);
      const view: ApiKeyView = {
        id: `key-${rid()}`,
        name: b.name,
        prefix,
        scopes,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        createdById: store.user.id,
        revokedAt: null,
        status: 'active',
      };
      state(store).apiKeys.unshift(view);
      // Plaintext key shown exactly once — `swk_<prefix>_<secret>`.
      const key = `swk_${prefix}_${rid(12)}${rid(12)}`;
      return { ...view, key };
    },

    'apiKeys.revoke': (input, store): { id: string; revoked: true } => {
      const { id } = input as { id: string };
      const k = state(store).apiKeys.find((x) => x.id === id);
      if (k) {
        k.revokedAt = new Date().toISOString();
        k.status = 'revoked';
      }
      return { id, revoked: true };
    },

    // ── oauth (client-credentials clients) ─────────────────────────────────────
    'oauth.list': (_i, store): OAuthClientView[] => state(store).oauthClients,

    'oauth.create': (input, store) => {
      const b = input as { name: string; scopes?: OAuthScope[] };
      const scopes = b.scopes && b.scopes.length ? b.scopes : (['read'] as OAuthScope[]);
      const view: OAuthClientView = {
        id: `oac-${rid()}`,
        name: b.name,
        clientId: `swc_${hex(24)}`,
        scopes,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        status: 'active',
      };
      state(store).oauthClients.unshift(view);
      // Plaintext secret shown exactly once — `swcs_…`.
      const clientSecret = `swcs_${rid(12)}${rid(12)}${rid(12)}`;
      return { ...view, clientSecret };
    },

    'oauth.revoke': (input, store): { id: string; revoked: true } => {
      const { id } = input as { id: string };
      const c = state(store).oauthClients.find((x) => x.id === id);
      if (c) {
        c.revokedAt = new Date().toISOString();
        c.status = 'revoked';
      }
      return { id, revoked: true };
    },

    // ── authConfig (sign-in providers) ─────────────────────────────────────────
    'authConfig.listProviders': (_i, store): ProviderListEntry[] => state(store).providers,

    'authConfig.setProvider': (input, store): ProviderListEntry => {
      const args = input as {
        type: string;
        enabled?: boolean;
        clientId?: string;
        clientSecret?: string;
        scopes?: string[];
      };
      const s = state(store);
      const p = s.providers.find((x) => x.type === args.type);
      if (!p) throw new Error(`unsupported provider "${args.type}"`);
      const social = p.kind === 'social';
      if (args.enabled !== undefined) p.enabled = args.enabled;
      if (social && args.clientId !== undefined) p.clientId = args.clientId;
      if (social && args.clientSecret) p.hasSecret = true;
      if (social && args.scopes !== undefined) p.scopes = args.scopes;
      return p;
    },

    // ── sso (enterprise per-org providers) ─────────────────────────────────────
    'sso.list': (_i, store): SsoProviderView[] => state(store).sso,

    'sso.upsert': (input, store): SsoProviderView => {
      const args = input as {
        id?: string;
        providerId: string;
        protocol: 'oidc' | 'saml';
        domain?: string | null;
        issuer?: string | null;
        clientId?: string | null;
        clientSecret?: string;
        enabled?: boolean;
        metadata?: Record<string, unknown>;
        mapping?: Record<string, string>;
      };
      const s = state(store);
      const existing = args.id ? s.sso.find((x) => x.id === args.id) : undefined;
      if (existing) {
        existing.providerId = args.providerId;
        existing.protocol = args.protocol;
        existing.domain = args.domain ?? null;
        existing.issuer = args.issuer ?? null;
        existing.clientId = args.clientId ?? null;
        if (args.clientSecret) existing.hasSecret = true;
        if (args.enabled !== undefined) existing.enabled = args.enabled;
        if (args.metadata) existing.metadata = args.metadata;
        if (args.mapping) existing.mapping = args.mapping;
        existing.callbackUrl = ssoCallbackUrl(existing.providerId);
        existing.loginUrl = ssoLoginUrl(existing.providerId);
        return existing;
      }
      const row: SsoProviderView = {
        id: `sso-${rid()}`,
        providerId: args.providerId,
        protocol: args.protocol,
        domain: args.domain ?? null,
        issuer: args.issuer ?? null,
        clientId: args.clientId ?? null,
        hasSecret: Boolean(args.clientSecret),
        enabled: args.enabled ?? true,
        metadata: args.metadata ?? {},
        mapping: args.mapping ?? {},
        callbackUrl: ssoCallbackUrl(args.providerId),
        loginUrl: ssoLoginUrl(args.providerId),
      };
      s.sso.push(row);
      return row;
    },

    'sso.delete': (input, store): { id: string; deleted: true } => {
      const { id } = input as { id: string };
      const s = state(store);
      s.sso = s.sso.filter((p) => p.id !== id);
      return { id, deleted: true };
    },

    // ── policies (ABAC) ────────────────────────────────────────────────────────
    'policies.list': (_i, store): PolicyView[] => state(store).policies,

    'policies.listActions': (): string[] => [...ACTIONS],

    'policies.validate': (input): { valid: boolean; error?: string; doc?: unknown } => {
      const { source } = input as { source: string };
      return validateSource(source);
    },

    'policies.set': (input, store): PolicyView => {
      const args = input as {
        id?: string;
        name: string;
        description?: string;
        effect: 'permit' | 'forbid';
        source: string;
        priority?: number;
        enabled?: boolean;
      };
      const check = validateSource(args.source);
      if (!check.valid) throw new Error(`invalid policy: ${check.error}`);
      const s = state(store);
      const existing = args.id ? s.policies.find((p) => p.id === args.id) : undefined;
      if (existing) {
        existing.name = args.name;
        existing.description = args.description ?? null;
        existing.effect = args.effect;
        existing.source = args.source;
        if (args.priority !== undefined) existing.priority = args.priority;
        if (args.enabled !== undefined) existing.enabled = args.enabled;
        existing.updatedAt = new Date().toISOString();
        s.policies.sort((a, b) => b.priority - a.priority);
        return existing;
      }
      const row: PolicyView = {
        id: `pol-${rid()}`,
        name: args.name,
        description: args.description ?? null,
        effect: args.effect,
        source: args.source,
        priority: args.priority ?? 0,
        enabled: args.enabled ?? true,
        isDefault: false,
        updatedAt: new Date().toISOString(),
      };
      s.policies.push(row);
      s.policies.sort((a, b) => b.priority - a.priority);
      return row;
    },

    'policies.delete': (input, store): { id: string; deleted: true } => {
      const { id } = input as { id: string };
      const s = state(store);
      const row = s.policies.find((p) => p.id === id);
      if (row?.isDefault) throw new Error('default policies cannot be deleted');
      s.policies = s.policies.filter((p) => p.id !== id);
      return { id, deleted: true };
    },

    'policies.simulate': (input, store) => {
      const args = input as { action: string; resourceType?: string; resourceId?: string };
      if (!(ACTIONS as readonly string[]).includes(args.action)) {
        throw new Error(`unknown action "${args.action}"`);
      }
      // The demo principal is the org owner → owner-superuser permits everything.
      const role = store.org.role;
      const reasons: string[] = [];
      let decision: 'permit' | 'deny' = 'deny';
      let policyId: string | null = null;

      if (role === 'owner' || role === 'admin') {
        decision = 'permit';
        policyId = role === 'owner' ? 'pol-default-0' : 'pol-default-1';
        reasons.push(`role "${role}" matches a superuser permit policy`);
      } else if (args.action.endsWith('.read')) {
        decision = 'permit';
        policyId = 'pol-default-2';
        reasons.push('members may read all resources');
      } else {
        reasons.push('no permit policy matched for this principal');
      }
      if (args.resourceType && args.resourceId) {
        reasons.push(`evaluated against ${args.resourceType}:${args.resourceId}`);
      }
      return { decision, policyId, reasons };
    },
  },
};
