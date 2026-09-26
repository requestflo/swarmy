import { STACK_TABS, type StackRoute, type StackSubTab, type StackTab } from './stack-nav';

/** The path after `/stacks/<name>/` ('' for the Services index), or null off the workspace. */
export function stackSubPath(pathname: string): string | null {
  const m = /^\/stacks\/[^/]+(?:\/(.*))?$/.exec(pathname.replace(/\/+$/, ''));
  if (!m) return null;
  return m[1] ?? '';
}

function ownsSub(sub: StackSubTab, rest: string): boolean {
  return rest === sub.path || (!sub.exact && rest.startsWith(`${sub.path}/`));
}

/** Which tab (and sub-tab) a workspace URL lights. Unknown paths light nothing. */
export function stackNavAt(pathname: string): { tab: StackTab | null; sub: StackSubTab | null } {
  const rest = stackSubPath(pathname);
  if (rest === null) return { tab: null, sub: null };
  const first = rest.split('/')[0] ?? '';
  const tab = STACK_TABS.find((t) => t.segments.includes(first)) ?? null;
  const sub = tab?.subs?.find((s) => ownsSub(s, rest)) ?? null;
  return { tab, sub };
}

/** A pre-2026-09-26 workspace URL and where it lives now. */
export interface LegacyStackPath {
  from: string;
  to: StackRoute;
}

/**
 * The old flat tabs that moved (2026-09-26, the board 9-tab IA). The rest kept
 * their URLs and only changed which tab they light.
 */
export const LEGACY_STACK_PATHS: LegacyStackPath[] = [
  { from: 'settings', to: '/stacks/$name/config/scaling' },
  { from: 'messaging', to: '/stacks/$name/config/jobs' },
];

/** `/stacks/$name/messaging#queues` (or any queue anchor) lands on Data › Queues. */
export function legacyStackTarget(from: string, hash = ''): StackRoute | null {
  const hit = LEGACY_STACK_PATHS.find((p) => p.from === from);
  if (!hit) return null;
  if (from === 'messaging' && /queue/i.test(hash)) return '/stacks/$name/queues';
  return hit.to;
}
