import type { CodeTab } from '@/components/calm';
import { policiesRest, policiesTerraform } from './policies-code';
import type { SignInMethod } from './use-signin-methods';
import type { PolicyRow } from './use-policy-editor';

function doc(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return source;
  }
}

interface InviteLinkLike {
  id: string;
  role: string;
  stackName: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  state: string;
  hint: string;
}

/** Invite links are a dashboard setting: the real tRPC calls (there is no REST route for them). */
function inviteLinksCode(links: InviteLinkLike[]): string {
  const live = links.map((l) => ({ id: l.id, link: l.hint, role: l.role, stackName: l.stackName, maxUses: l.maxUses, uses: l.uses, expiresAt: l.expiresAt, state: l.state }));
  return [
    '# Dashboard setting (tRPC), no REST route',
    'inviteLinks.create ' + JSON.stringify({ role: 'member', stackName: 'storefront', expiry: '7d', maxUses: 10 }),
    '# -> { url: ".../join/swi_…" } shown once;\n#    only a hash of the token is kept',
    'inviteLinks.list',
    'inviteLinks.revoke { "id": "<link id>" }',
    '',
    '# whoever opens /join/swi_… signs in, then',
    'authConfig.invitePreview { "id": "swi_…" }',
    'authConfig.acceptInvite  { "id": "swi_…" }',
    '',
    '# the links today (tokens masked)',
    JSON.stringify(live, null, 2),
  ].join('\n');
}

/** Sign-in: the methods, plus the SSO-only switch as the real tRPC call. */
function signInCode(methods: SignInMethod[], ssoOnly: boolean | null): string {
  const list = JSON.stringify(methods.map((m) => ({ method: m.label, kind: m.kind, enabled: m.enabled })), null, 2);
  if (ssoOnly === null) return list;
  return [
    '# Members sign in with SSO only: dashboard setting (tRPC), no REST route',
    `security.ssoOnly.set { "on": ${ssoOnly} }`,
    '# owners keep password + 2FA; each use audited as auth.breakGlass.signIn',
    '# invites: members.invite / inviteLinks.create { "requireSso": true }',
    '',
    list,
  ].join('\n');
}

/** The rules as the policy documents the engine runs (JSON, Cedar-compatible) and as REST + Terraform, the sign-in set and the invite links. */
export function accessCode(
  rules: PolicyRow[],
  methods: SignInMethod[],
  links: InviteLinkLike[] | null = null,
  ssoOnly: boolean | null = null,
): CodeTab[] {
  const policies = rules.map((r) => ({ id: r.id, name: r.name, effect: r.effect, priority: r.priority, enabled: r.enabled, default: r.isDefault, policy: doc(r.source) }));
  return [
    { label: 'policy JSON', code: JSON.stringify(policies, null, 2) },
    { label: 'curl', code: policiesRest(rules) },
    { label: 'Terraform', code: policiesTerraform(rules) },
    { label: 'sign-in', code: signInCode(methods, ssoOnly) },
    ...(links ? [{ label: 'invite links', code: inviteLinksCode(links) }] : []),
  ];
}
