import {
  ACTIONS as ABAC_ACTIONS,
  DEFAULT_POLICY_SPECS,
  JsonPolicyEngine,
  buildPrincipal,
  describePolicy,
  isAction,
  parsePolicyDoc,
  type PolicyDoc,
  type Role,
} from '@swarmy/abac/model';
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
  settings: Record<string, string>;
  label: string;
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
interface InvitationView {
  id: string;
  email: string | null;
  kind: 'link' | 'email';
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'expired';
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; name: string | null; email: string | null } | null;
  link: string;
}

interface AccessState {
  members: MemberView[];
  invitations: InvitationView[];
  grants: GrantView[];
  apiKeys: ApiKeyView[];
  oauthClients: OAuthClientView[];
  providers: ProviderListEntry[];
  sso: SsoProviderView[];
  policies: PolicyView[];
}

// ── Constants mirrored from the services ──────────────────────────────────────


const SOCIAL_PROVIDERS = ['microsoft', 'google', 'github', 'gitlab'] as const;
const SOCIAL_LABELS: Record<string, string> = { microsoft: 'Microsoft', google: 'Google', github: 'GitHub', gitlab: 'GitLab' };
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

const inviteLink = (id: string): string => `${window.location.origin}/login?invite=${id}`;

function seedInvitations(store: DemoStore): InvitationView[] {
  const by = { id: store.user.id, name: store.user.name, email: store.user.email };
  return [
    {
      id: 'inv-demo-1',
      email: 'priya@northwind.dev',
      kind: 'email',
      role: 'member',
      status: 'pending',
      expiresAt: new Date(now + 40 * HOUR).toISOString(),
      createdAt: iso(8 * HOUR),
      invitedBy: by,
      link: inviteLink('inv-demo-1'),
    },
    {
      id: 'inv-demo-0',
      email: 'sam@northwind.dev',
      kind: 'email',
      role: 'admin',
      status: 'expired',
      expiresAt: iso(2 * DAY),
      createdAt: iso(4 * DAY),
      invitedBy: by,
      link: inviteLink('inv-demo-0'),
    },
  ];
}

function mintInvitation(store: DemoStore, email: string | null, role: InvitationView['role']): InvitationView {
  const id = `inv-${rid()}`;
  const view: InvitationView = {
    id,
    email,
    kind: email ? 'email' : 'link',
    role,
    status: 'pending',
    expiresAt: new Date(Date.now() + 48 * HOUR).toISOString(),
    createdAt: new Date().toISOString(),
    invitedBy: { id: store.user.id, name: store.user.name, email: store.user.email },
    link: inviteLink(id),
  };
  state(store).invitations.unshift(view);
  return view;
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
    const configured = type === 'github' || type === 'microsoft';
    return {
      type,
      kind: 'social',
      label: SOCIAL_LABELS[type] ?? type,
      settings: (type === 'microsoft' ? { tenantId: 'northwind.onmicrosoft.com' } : {}) as Record<string, string>,
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
    label: type === 'passkey' ? 'Passkeys' : 'Magic link',
    clientId: null,
    hasSecret: false,
    scopes: [],
    settings: {},
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
  // The real seeded set (packages/abac defaults), so the demo reads the same rules.
  const defaults = DEFAULT_POLICY_SPECS;

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
      id: 'pol-payments-prod',
      name: 'Payments ships its own production',
      description: 'The payments team deploys and restarts production payment apps.',
      effect: 'permit',
      priority: 65,
      source: JSON.stringify(
        {
          groups: ['team-payments'],
          actions: ['service.deploy', 'service.configure', 'service.restart', 'stack.deploy'],
          conditions: [
            { attr: 'resource.env', op: 'eq', value: 'production' },
            { attr: 'resource.label.team', op: 'eq', value: 'payments' },
          ],
        },
        null,
        2,
      ),
      enabled: true,
      isDefault: false,
      updatedAt: iso(2 * HOUR),
    },
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


function validateSource(
  source: string,
  effect: 'permit' | 'forbid' = 'permit',
): { valid: boolean; error?: string; doc?: PolicyDoc; sentence?: string } {
  try {
    const doc = parsePolicyDoc(source);
    return { valid: true, doc, sentence: describePolicy(effect, doc) };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A policy row as policies.service returns it: plus its parsed doc + sentence. */
function policyWithSentence(p: PolicyView): PolicyView & { doc: PolicyDoc | null; sentence: string } {
  const v = validateSource(p.source, p.effect);
  return { ...p, doc: v.doc ?? null, sentence: v.sentence ?? 'This rule no longer parses; edit its JSON.' };
}

/** The demo org's rules as a real engine (same decisions as the controller). */
function demoEngine(store: DemoStore): JsonPolicyEngine {
  return new JsonPolicyEngine(state(store).policies);
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

export const access: DomainResolvers = {
  seed(store) {
    const s: AccessState = {
      members: seedMembers(),
      invitations: seedInvitations(store),
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

    // ── invitations (settings → members; copy-a-link) ─────────────────────────
    'members.listInvitations': (_i, store): InvitationView[] => state(store).invitations,

    'members.invite': (input, store): InvitationView => {
      const { email, role } = input as { email?: string | null; role: InvitationView['role'] };
      const normalized = (email ?? '').trim().toLowerCase();
      if (!normalized) return mintInvitation(store, null, role);
      const s = state(store);
      if (s.members.some((m) => m.user.email?.toLowerCase() === normalized)) {
        throw new Error(`${normalized} is already a member of this org`);
      }
      if (s.invitations.some((i) => i.email === normalized && i.status === 'pending')) {
        throw new Error(`${normalized} already has a pending invite — copy or regenerate its link below`);
      }
      return mintInvitation(store, normalized, role);
    },

    'members.revokeInvitation': (input, store): { id: string; revoked: true } => {
      const { id } = input as { id: string };
      const s = state(store);
      s.invitations = s.invitations.filter((i) => i.id !== id);
      return { id, revoked: true };
    },

    'members.regenerateInvitation': (input, store): InvitationView => {
      const { id } = input as { id: string };
      const s = state(store);
      const old = s.invitations.find((i) => i.id === id);
      if (!old) throw new Error(`invitation "${id}" not found`);
      s.invitations = s.invitations.filter((i) => i.id !== id);
      return mintInvitation(store, old.email, old.role);
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
    'authConfig.publicConfig': (_i, store) => ({
      signupMode: 'open' as const,
      signIn: [
        ...state(store).sso.filter((p) => p.enabled && p.protocol === 'oidc').map((p) => ({
          kind: 'sso' as const,
          id: p.providerId,
          label: typeof p.metadata.displayName === 'string' ? p.metadata.displayName : p.providerId,
        })),
        ...state(store).providers
          .filter((p) => p.kind === 'social' && p.enabled && p.hasSecret)
          .map((p) => ({ kind: 'social' as const, id: p.type, label: p.label })),
      ],
    }),
    'authConfig.invitePreview': (input, store) => {
      const inv = state(store).invitations.find((i) => i.id === (input as { id: string }).id);
      return inv ? { orgName: store.org.name, role: inv.role, email: inv.email, expired: inv.status === 'expired' } : null;
    },
    'authConfig.acceptInvite': (_i, store) => ({ orgId: store.org.id }),

    'authConfig.setProvider': (input, store): ProviderListEntry => {
      const args = input as {
        type: string;
        enabled?: boolean;
        clientId?: string;
        clientSecret?: string;
        scopes?: string[];
        settings?: Record<string, string>;
      };
      const s = state(store);
      const p = s.providers.find((x) => x.type === args.type);
      if (!p) throw new Error(`unsupported provider "${args.type}"`);
      const social = p.kind === 'social';
      if (args.enabled !== undefined) p.enabled = args.enabled;
      if (social && args.clientId !== undefined) p.clientId = args.clientId;
      if (social && args.clientSecret) p.hasSecret = true;
      if (social && args.scopes !== undefined) p.scopes = args.scopes;
      if (social && args.settings) p.settings = Object.fromEntries(Object.entries(args.settings).filter(([, v]) => v));
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
    'policies.list': (_i, store) => state(store).policies.map(policyWithSentence),

    'policies.listActions': (): string[] => [...ABAC_ACTIONS],

    'policies.validate': (input) => {
      const { source, effect } = input as { source: string; effect?: 'permit' | 'forbid' };
      return validateSource(source, effect);
    },

    'policies.resetDefaults': (_i, store) => {
      const s = state(store);
      const fresh = seedPolicies().filter((p) => p.isDefault);
      s.policies = [...fresh, ...s.policies.filter((p) => !p.isDefault)].sort((a, b) => b.priority - a.priority);
      return s.policies.map(policyWithSentence);
    },

    'policies.whoCan': (input, store) => {
      const args = input as { action: string; resourceType?: string; resourceId?: string; env?: string; labels?: Record<string, string> };
      if (!isAction(args.action)) throw new Error(`unknown action "${args.action}"`);
      const resource =
        args.resourceType || args.env || args.resourceId
          ? {
              type: args.resourceType ?? 'service',
              id: args.resourceId ?? '(any)',
              orgId: store.org.id,
              // Demo apps named *prod* / on the payments team read as labelled.
              labels: {
                ...(args.labels ?? {}),
                ...(args.resourceId && /prod|api|pay/.test(args.resourceId) ? { 'swarmy.env': 'production' } : {}),
                ...(args.resourceId && /pay/.test(args.resourceId) ? { team: 'payments' } : {}),
              },
              env: args.resourceId ? undefined : args.env,
            }
          : null;
      const engine = demoEngine(store);
      const s = state(store);
      const rows = s.members.map((m) => {
        const principal = buildPrincipal({
          userId: m.user.id,
          orgId: store.org.id,
          role: m.role as Role,
          memberId: m.id,
          teamIds: Array.isArray(m.attributes.teamIds) ? (m.attributes.teamIds as string[]) : [],
          attributes: m.attributes,
        });
        const d = engine.evaluate({ principal, action: args.action as never, resource });
        return {
          memberId: m.id,
          userId: m.user.id,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          groups: principal.groups ?? [],
          decision: d.decision,
          policyId: d.policyId,
          reasons: d.reasons,
        };
      });
      return { action: args.action, resource, rows };
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
      if (!isAction(args.action)) throw new Error(`unknown action "${args.action}"`);
      const me = state(store).members.find((m) => m.user.id === store.user.id);
      const principal = buildPrincipal({
        userId: store.user.id,
        orgId: store.org.id,
        role: store.org.role,
        memberId: me?.id ?? null,
        attributes: me?.attributes ?? {},
      });
      const resource =
        args.resourceType && args.resourceId
          ? { type: args.resourceType, id: args.resourceId, orgId: store.org.id, labels: {} }
          : null;
      const { decision, policyId, reasons } = demoEngine(store).evaluate({ principal, action: args.action, resource });
      return { decision, policyId, reasons };
    },
  },
};
