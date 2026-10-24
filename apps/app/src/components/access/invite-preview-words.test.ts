import { describe, expect, test } from 'bun:test';
import { defaultPolicyInputs, simulateInvite } from '@swarmy/abac/model';
import { appList, previewLines } from './invite-preview-words';

const DEFAULTS = defaultPolicyInputs().map((p) => ({ ...p, id: `default:${p.key}` }));
const APPS = [
  { id: 's1', name: 'storefront', labels: {} },
  { id: 's2', name: 'payments', labels: { 'swarmy.env': 'production' } },
];

describe('appList', () => {
  test('joins up to three names, then counts the rest', () => {
    expect(appList(['a'])).toBe('a');
    expect(appList(['a', 'b'])).toBe('a and b');
    expect(appList(['a', 'b', 'c'])).toBe('a, b and c');
    expect(appList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});

describe('previewLines (They can / They can’t)', () => {
  test('a member with no app: outside production on one side, the rest on the other', () => {
    const { can, cant } = previewLines(simulateInvite(DEFAULTS, { orgId: 'o', role: 'member', grantedAppIds: [] }, APPS), 2);
    expect(can.map((l) => l.text)).toEqual(['deploy storefront', 'restart storefront', 'see logs on every app', 'change domains on storefront']);
    expect(cant.map((l) => l.text)).toEqual([
      'deploy payments',
      'restart payments',
      'open a shell',
      'change domains on payments',
      'manage people',
      'delete data',
    ]);
  });

  test('an admin can do all of it', () => {
    const { can, cant } = previewLines(simulateInvite(DEFAULTS, { orgId: 'o', role: 'admin', grantedAppIds: [] }, APPS), 2);
    expect(cant).toEqual([]);
    expect(can[0]!.text).toBe('deploy every app');
  });

  test('a forbid rule is named on the line it blocks; no apps yet reads "new apps"', () => {
    const forbid = { id: 'p1', name: 'No shells, ever', effect: 'forbid' as const, priority: 1, enabled: true, source: JSON.stringify({ actions: ['terminal.open'] }) };
    const { can, cant } = previewLines(simulateInvite([...DEFAULTS, forbid], { orgId: 'o', role: 'owner', grantedAppIds: [] }, []), 0);
    expect(can[0]!.text).toBe('deploy new apps');
    expect(cant).toEqual([{ key: 'shell', text: 'open a shell', policy: 'No shells, ever' }]);
  });
});
