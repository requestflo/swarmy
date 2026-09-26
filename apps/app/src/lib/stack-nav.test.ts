import { describe, expect, it } from 'bun:test';
import { STACK_TABS, SYSTEM_STACK_TABS } from './stack-nav';
import { legacyStackTarget, stackNavAt } from './stack-nav-match';

const at = (p: string): string => {
  const { tab, sub } = stackNavAt(p);
  return [tab?.label ?? '-', sub?.label ?? '-'].join(' › ');
};

describe('stack nav (board 9-tab IA)', () => {
  it('has the nine board tabs, in order', () => {
    expect(STACK_TABS.map((t) => t.label)).toEqual([
      'Services', 'Domains', 'Data', 'Observability', 'Access', 'Config', 'Backups', 'Releases', 'Source',
    ]);
  });

  it('keeps the system stack to Services, Observability and Source', () => {
    expect(SYSTEM_STACK_TABS.map((t) => t.label)).toEqual(['Services', 'Observability', 'Source']);
  });

  it('lights the right tab and sub-tab for every workspace URL', () => {
    const cases: Record<string, string> = {
      '/stacks/shop': 'Services › -',
      '/stacks/shop/': 'Services › -',
      '/stacks/shop/network': 'Domains › -',
      '/stacks/shop/data': 'Data › Databases',
      '/stacks/shop/studio': 'Data › Studio',
      '/stacks/shop/queues': 'Data › Queues',
      '/stacks/shop/queues/main': 'Data › Queues',
      '/stacks/shop/observability': 'Observability › Logs & traces',
      '/stacks/shop/replays/abc': 'Observability › Replays',
      '/stacks/shop/errors/f00': 'Observability › Errors',
      '/stacks/shop/analytics': 'Observability › Analytics',
      '/stacks/shop/rum-settings': 'Observability › Settings',
      '/stacks/shop/access': 'Access › -',
      '/stacks/shop/config': 'Config › Variables & secrets',
      '/stacks/shop/config/scaling': 'Config › Scaling',
      '/stacks/shop/config/rollout': 'Config › Health & rollout',
      '/stacks/shop/config/placement': 'Config › Placement & volumes',
      '/stacks/shop/config/jobs': 'Config › Jobs & previews',
      '/stacks/shop/backups': 'Backups › -',
      '/stacks/shop/releases': 'Releases › -',
      '/stacks/shop/source': 'Source › -',
      '/nodes': '- › -',
    };
    for (const [path, want] of Object.entries(cases)) expect(`${path} → ${at(path)}`).toBe(`${path} → ${want}`);
  });

  it('maps every old URL to its new home', () => {
    expect(legacyStackTarget('settings')).toBe('/stacks/$name/config/scaling');
    expect(legacyStackTarget('messaging')).toBe('/stacks/$name/config/jobs');
    expect(legacyStackTarget('messaging', '#queues')).toBe('/stacks/$name/queues');
    expect(legacyStackTarget('messaging', 'queue-orders')).toBe('/stacks/$name/queues');
    // URLs that kept their path are not redirected.
    for (const kept of ['data', 'studio', 'config', 'errors', 'analytics', 'replays', 'rum-settings', 'releases', 'backups']) {
      expect(legacyStackTarget(kept)).toBeNull();
    }
  });

  it('lands every old URL on a tab', () => {
    for (const from of ['settings', 'messaging']) {
      const to = legacyStackTarget(from)!.replace('$name', 'shop');
      expect(stackNavAt(to).tab).not.toBeNull();
    }
  });
});
