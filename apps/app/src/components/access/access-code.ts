import type { CodeTab } from '@/components/calm';
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

/** The rules as the policy documents the engine runs (JSON, Cedar-compatible), the sign-in set and the invite links. */
export function accessCode(rules: PolicyRow[], methods: SignInMethod[], links: InviteLinkLike[] | null = null): CodeTab[] {
  const policies = rules.map((r) => ({ id: r.id, name: r.name, effect: r.effect, priority: r.priority, enabled: r.enabled, default: r.isDefault, policy: doc(r.source) }));
  return [
    { label: 'policy JSON', code: JSON.stringify(policies, null, 2) },
    { label: 'sign-in', code: JSON.stringify(methods.map((m) => ({ method: m.label, kind: m.kind, enabled: m.enabled })), null, 2) },
    ...(links ? [{ label: 'invite links', code: inviteLinksCode(links) }] : []),
  ];
}
