import {
  ActivityIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  FileCode2Icon,
  LayoutDashboardIcon,
  NetworkIcon,
  RocketIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from 'lucide-react';
import { CONFIG_SUBS, DATA_SUBS, OBS_SUBS, type StackRoute, type StackSubTab } from './stack-nav-subs';

export type { StackRoute, StackSubTab } from './stack-nav-subs';

/**
 * The app workspace tab registry — the in-stack counterpart of
 * `lib/destinations.ts`. The boards' nine tabs (Services · Domains · Data ·
 * Observability · Access · Config · Backups · Releases · Source); Data,
 * Observability and Config carry sub-tabs (`stack-nav-subs.ts`). Every
 * stack-scoped surface is a child route of `/stacks/$name`; the workspace
 * tab strip and the palette read this. Which tab a URL lights is
 * `stackNavAt` (`stack-nav-match.ts`).
 */
export interface StackTab {
  /** Typed route: the tab's landing page (its first sub-tab when it has them). */
  to: StackRoute;
  label: string;
  icon: LucideIcon;
  /** One-line explainer (palette hint). */
  blurb: string;
  /** Keywords to widen palette fuzzy-search. */
  keywords?: string;
  /** First path segments after `/stacks/<name>/` that light this tab ('' = the index). */
  segments: string[];
  /** The secondary strip under the tab strip. */
  subs?: StackSubTab[];
  /**
   * Whether this tab applies to the `swarmy-system` platform stack. That
   * stack is shared plumbing (collector, ingress, storage, mesh control
   * plane), not a user app, so only Services (the live canvas),
   * Observability (the store lives here) and Source (its read-only spec)
   * make sense. Defaults to `true` when absent.
   */
  systemSafe?: boolean;
}

export const STACK_TABS: StackTab[] = [
  {
    to: '/stacks/$name',
    label: 'Services',
    icon: LayoutDashboardIcon,
    blurb: 'How the app is built, live',
    keywords: 'overview canvas graph services parts health',
    segments: [''],
    systemSafe: true,
  },
  {
    to: '/stacks/$name/network',
    label: 'Domains',
    icon: NetworkIcon,
    blurb: 'Domains, protections & geo DNS',
    keywords: 'network ingress domains routes tls https rate limit protection ip allow deny geo dns',
    segments: ['network'],
    systemSafe: false,
  },
  {
    to: '/stacks/$name/data',
    label: 'Data',
    icon: DatabaseIcon,
    blurb: 'Databases, studio & queues',
    keywords: 'postgres database managed redis valkey cache search vector studio sql queues bullmq',
    segments: ['data', 'studio', 'queues'],
    subs: DATA_SUBS,
    systemSafe: false,
  },
  {
    to: '/stacks/$name/observability',
    label: 'Observability',
    icon: ActivityIcon,
    blurb: 'Logs, traces, replays, errors & analytics',
    keywords: 'observability logs metrics traces otel status page errors sentry replays analytics rum',
    segments: ['observability', 'replays', 'errors', 'analytics', 'rum-settings'],
    subs: OBS_SUBS,
    systemSafe: true,
  },
  {
    to: '/stacks/$name/access',
    label: 'Access',
    icon: ShieldCheckIcon,
    blurb: 'Who can reach this app: login, people, laptops',
    keywords: 'login sso protect private identity proxy forward auth users sign in laptop mesh people',
    segments: ['access'],
    systemSafe: false,
  },
  {
    to: '/stacks/$name/config',
    label: 'Config',
    icon: SlidersHorizontalIcon,
    blurb: 'Variables, scaling, rollout, placement, jobs',
    keywords: 'config settings variables secrets scaling copies rollout canary placement jobs cron webhooks previews',
    segments: ['config'],
    subs: CONFIG_SUBS,
    systemSafe: false,
  },
  {
    to: '/stacks/$name/backups',
    label: 'Backups',
    icon: DatabaseBackupIcon,
    blurb: 'DR setup & resilience',
    keywords: 'backups snapshots restore disaster recovery schedules off-site resilience drills',
    segments: ['backups'],
    systemSafe: false,
  },
  {
    to: '/stacks/$name/releases',
    label: 'Releases',
    icon: RocketIcon,
    blurb: 'History, environments & put back',
    keywords: 'deploys history rollback put back environments promote',
    segments: ['releases'],
    systemSafe: false,
  },
  {
    to: '/stacks/$name/source',
    label: 'Source',
    icon: FileCode2Icon,
    blurb: 'The spec this app runs from, read-only',
    keywords: 'source spec compose swarmy.yaml git repo code',
    segments: ['source'],
    systemSafe: true,
  },
];

/** The subset of {@link STACK_TABS} shown for the `swarmy-system` stack. */
export const SYSTEM_STACK_TABS: StackTab[] = STACK_TABS.filter((tab) => tab.systemSafe !== false);
