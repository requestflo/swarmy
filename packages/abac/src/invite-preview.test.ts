import { describe, expect, it } from 'bun:test';
import { defaultPolicyInputs } from './defaults';
import { INVITE_ABILITIES, simulateInvite, type InviteApp, type InviteVerdict } from './invite-preview';
import type { PolicyInput } from './types';

const DEFAULTS: PolicyInput[] = defaultPolicyInputs().map((p) => ({ ...p, id: `default:${p.key}` }));
const APPS: InviteApp[] = [
  { id: 's-store', name: 'storefront', labels: {} },
  { id: 's-pay', name: 'payments', labels: { 'swarmy.env': 'production' } },
];

function byKey(verdicts: InviteVerdict[]): Record<string, InviteVerdict> {
  return Object.fromEntries(verdicts.map((v) => [v.key, v]));
}

describe('simulateInvite (the invite form\'s live "they can" preview)', () => {
  it('covers the seven plain-words abilities on the gates they really run on', () => {
    expect(INVITE_ABILITIES.map((a) => `${a.label}:${a.action}@${a.on}`)).toEqual([
      'deploy:stack.deploy@stack',
      'restart:service.restart@service',
      'see logs:service.read@service',
      'open a shell:terminal.open@service',
      'change domains:ingress.write@service',
      'manage people:member.write@org',
      'delete data:data.destroy@org',
    ]);
  });

  it('a member with no app: everything outside production, nothing destructive', () => {
    const v = byKey(simulateInvite(DEFAULTS, { orgId: 'o1', role: 'member', grantedAppIds: [] }, APPS));
    expect(v.deploy).toMatchObject({ reach: 'some', allowedOn: ['storefront'], deniedOn: ['payments'], blockedBy: null });
    expect(v.deploy!.permitBy?.id).toBe('default:member-safe-ops');
    expect(v.logs).toMatchObject({ reach: 'all', allowedOn: ['storefront', 'payments'] });
    expect(v.domains!.reach).toBe('some');
    expect(v.shell).toMatchObject({ reach: 'none', blockedBy: null, permitBy: null });
    expect(v.people!.reach).toBe('none');
    expect(v.data!.reach).toBe('none');
  });

  it('an app grant adds operator on THAT app (production included) for stack-level actions only', () => {
    const v = byKey(simulateInvite(DEFAULTS, { orgId: 'o1', role: 'member', grantedAppIds: ['s-pay'] }, APPS));
    expect(v.deploy).toMatchObject({ reach: 'all', deniedOn: [] });
    // A stack grant does not reach its parts' gates: restarting a production part still needs a rule.
    expect(v.restart).toMatchObject({ reach: 'some', deniedOn: ['payments'] });
  });

  it('owners and admins can do all of it; app grants are ignored', () => {
    for (const role of ['owner', 'admin'] as const) {
      const v = simulateInvite(DEFAULTS, { orgId: 'o1', role, grantedAppIds: ['s-store'] }, APPS);
      expect(v.every((x) => x.reach === 'all')).toBe(true);
    }
  });

  it('names the forbid rule that blocks an ability ("Blocked by policy")', () => {
    const forbid: PolicyInput = {
      id: 'pol-1',
      name: 'Nobody deletes production data',
      effect: 'forbid',
      priority: 10,
      enabled: true,
      source: JSON.stringify({ actions: ['data.destroy', 'stack.deploy'], conditions: [{ attr: 'resource.env', op: 'eq', value: 'production' }] }),
    };
    const v = byKey(simulateInvite([...DEFAULTS, forbid], { orgId: 'o1', role: 'admin', grantedAppIds: [] }, APPS));
    expect(v.deploy).toMatchObject({ reach: 'some', deniedOn: ['payments'], blockedBy: { id: 'pol-1', name: 'Nobody deletes production data' } });
    // Workspace-level data deletes carry no env, so the production-only forbid doesn't bite.
    expect(v.data).toMatchObject({ reach: 'all', blockedBy: null });
  });

  it('with no apps yet, judges a brand-new unlabelled app', () => {
    const v = byKey(simulateInvite(DEFAULTS, { orgId: 'o1', role: 'member', grantedAppIds: [] }, []));
    expect(v.deploy).toMatchObject({ reach: 'all', allowedOn: [], deniedOn: [] });
    expect(v.shell!.reach).toBe('none');
  });

  it('a disabled rule is not evaluated', () => {
    const off = DEFAULTS.map((p) => (p.id === 'default:member-safe-ops' ? { ...p, enabled: false } : p));
    const v = byKey(simulateInvite(off, { orgId: 'o1', role: 'member', grantedAppIds: [] }, APPS));
    expect(v.deploy!.reach).toBe('none');
  });
});
