import { describe, expect, test } from 'bun:test';
import { defaultPolicyInputs } from '@swarmy/abac/model';
import { rolesAtAGlance } from './role-lines';

const DEFAULTS = defaultPolicyInputs();

describe('rolesAtAGlance (the real role sentences)', () => {
  test('the shipped defaults, per role, highest priority first', () => {
    const g = rolesAtAGlance(DEFAULTS);
    expect(g.roles).toEqual([
      { role: 'owner', lines: ['Owners can do anything', 'Only an owner can invite another owner'] },
      { role: 'admin', lines: ['Admins can do anything'] },
      {
        role: 'member',
        lines: [
          'Members can read',
          'Members can deploy and operate outside production',
          'Members can connect to non-production stacks',
          'Members can read non-production databases',
          'Members can use AI models',
          'Members can remove alerts, status pages, jobs and AI keys',
          'Members can remove inbound webhooks',
          'Members can remove saved queries',
        ],
      },
    ]);
    expect(g.grants).toEqual(['Resource operators can operate their resources']);
  });

  test('a disabled default drops out; a rule for everyone lands on every role; group rules are not a role’s', () => {
    const rules = [
      ...DEFAULTS.map((p) => (p.key === 'member-ai-use' ? { ...p, enabled: false } : p)),
      { name: 'Nobody opens shells', effect: 'forbid' as const, priority: 200, enabled: true, source: JSON.stringify({ actions: ['terminal.open'] }) },
      { name: 'Platform deploys prod', effect: 'permit' as const, priority: 60, enabled: true, source: JSON.stringify({ groups: ['platform'], actions: ['stack.deploy'] }) },
      { name: 'broken', effect: 'permit' as const, priority: 1, enabled: true, source: '{nope' },
    ];
    const g = rolesAtAGlance(rules);
    expect(g.roles.every((r) => r.lines[0] === 'Nobody opens shells')).toBe(true);
    const member = g.roles.find((r) => r.role === 'member')!.lines;
    expect(member).not.toContain('Members can use AI models');
    expect(member).not.toContain('Platform deploys prod');
    expect(member).not.toContain('broken');
  });
});
