import {
  ActivityIcon,
  BarChart3Icon,
  BugIcon,
  ClapperboardIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  LockKeyholeIcon,
  NetworkIcon,
  RocketIcon,
  ShieldCheckIcon,
  SettingsIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The stack workspace tab registry — the in-stack counterpart of
 * `lib/destinations.ts`. Every stack-scoped surface hangs off `/stacks/$name`
 * as a child route; the workspace tab strip and the ⌘K palette read this.
 */

export interface StackTab {
  /** Typed route id under the stack workspace. */
  to:
    | '/stacks/$name'
    | '/stacks/$name/data'
    | '/stacks/$name/messaging'
    | '/stacks/$name/observability'
    | '/stacks/$name/errors'
    | '/stacks/$name/analytics'
    | '/stacks/$name/replays'
    | '/stacks/$name/network'
    | '/stacks/$name/access'
    | '/stacks/$name/config'
    | '/stacks/$name/backups'
    | '/stacks/$name/releases'
    | '/stacks/$name/settings';
  label: string;
  icon: LucideIcon;
  /** One-line explainer (palette hint). */
  blurb: string;
  /** Keywords to widen palette fuzzy-search. */
  keywords?: string;
  /** Exact-match active styling (the Overview index tab). */
  exact?: boolean;
  /**
   * Whether this tab applies to the `swarmy-system` platform stack. That
   * stack is shared plumbing (observability collector, ingress, storage,
   * mesh control-plane), not a user app — so app-oriented surfaces (data,
   * messaging, network, config, backups, releases, settings) don't apply.
   * Overview (the live canvas) and Observability (the store lives here)
   * are the only surfaces that make sense. Defaults to `true` when absent.
   */
  systemSafe?: boolean;
}

export const STACK_TABS: StackTab[] = [
  {
    to: '/stacks/$name',
    label: 'Overview',
    icon: LayoutDashboardIcon,
    blurb: 'The live service canvas',
    keywords: 'canvas graph services health',
    exact: true,
    systemSafe: true,
  },
  {
    to: '/stacks/$name/data',
    label: 'Data',
    icon: DatabaseIcon,
    blurb: 'Databases, caches, search & vector',
    keywords: 'postgres database managed redis valkey cache meilisearch typesense search qdrant pgvector vector',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/messaging',
    label: 'Messaging',
    icon: WorkflowIcon,
    blurb: 'Queues, webhooks & jobs',
    keywords: 'bullmq queues workers webhooks endpoints deliveries cron scheduled jobs',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/observability',
    label: 'Observability',
    icon: ActivityIcon,
    blurb: 'Logs, metrics, traces & status page',
    keywords: 'logs metrics traces otel telemetry service map health status page uptime',
    systemSafe: true,
  },
  {
    to: '/stacks/$name/errors',
    label: 'Errors',
    icon: BugIcon,
    blurb: 'Sentry-compatible error tracking',
    keywords: 'errors exceptions issues sentry dsn crashes stack trace source maps regressions',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/analytics',
    label: 'Analytics',
    icon: BarChart3Icon,
    blurb: 'Visitors, pages & web vitals — counted at the edge',
    keywords: 'rum analytics visitors pageviews referrers web vitals lcp cls inp countries browsers',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/replays',
    label: 'Replays',
    icon: ClapperboardIcon,
    blurb: 'Session replays of real visits',
    keywords: 'session replay recordings rrweb rum user sessions',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/network',
    label: 'Network',
    icon: NetworkIcon,
    blurb: 'Domains, protections & geo DNS',
    keywords: 'ingress domains routes tls https rate limit protection ip allow deny geo dns',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/access',
    label: 'Access',
    icon: ShieldCheckIcon,
    blurb: 'Who can reach this app: login, people, laptops',
    keywords: 'login sso protect private identity proxy forward auth users sign in auth better-auth laptop mesh netbird connect people',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/config',
    label: 'Config',
    icon: LockKeyholeIcon,
    blurb: 'Secrets & configs',
    keywords: 'secrets rotation configs env files versions',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/backups',
    label: 'Backups',
    icon: DatabaseBackupIcon,
    blurb: 'DR setup & resilience',
    keywords: 'backups snapshots restore disaster recovery schedules off-site second destination resilience drills unprotected',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/releases',
    label: 'Releases',
    icon: RocketIcon,
    blurb: 'History, canary & rollback',
    keywords: 'deploys history rollback canary blue green health gates strategy',
    systemSafe: false,
  },
  {
    to: '/stacks/$name/settings',
    label: 'Settings',
    icon: SettingsIcon,
    blurb: 'AI access, danger zone',
    keywords: 'rename ai gateway access expose outlet danger remove',
    systemSafe: false,
  },
];

/** The subset of {@link STACK_TABS} shown for the `swarmy-system` stack. */
export const SYSTEM_STACK_TABS: StackTab[] = STACK_TABS.filter((tab) => tab.systemSafe);
