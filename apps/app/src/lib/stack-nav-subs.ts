/** Every typed route a workspace tab or sub-tab links to. */
export type StackRoute =
  | '/stacks/$name'
  | '/stacks/$name/network'
  | '/stacks/$name/data'
  | '/stacks/$name/studio'
  | '/stacks/$name/queues'
  | '/stacks/$name/observability'
  | '/stacks/$name/replays'
  | '/stacks/$name/errors'
  | '/stacks/$name/analytics'
  | '/stacks/$name/rum-settings'
  | '/stacks/$name/access'
  | '/stacks/$name/config'
  | '/stacks/$name/config/scaling'
  | '/stacks/$name/config/rollout'
  | '/stacks/$name/config/placement'
  | '/stacks/$name/config/jobs'
  | '/stacks/$name/backups'
  | '/stacks/$name/releases'
  | '/stacks/$name/source';

/** One entry of a tab's secondary strip. */
export interface StackSubTab {
  to: StackRoute;
  label: string;
  /** Path after `/stacks/<name>/` this sub-tab owns (it and everything under it). */
  path: string;
  /** Own only `path` itself, not what's under it (Config › Variables vs Config › Scaling). */
  exact?: boolean;
  /** Palette hint. */
  blurb: string;
  keywords?: string;
  /** Shown for the `swarmy-system` stack (defaults to false: sub-tabs are app surfaces). */
  systemSafe?: boolean;
}

export const DATA_SUBS: StackSubTab[] = [
  { to: '/stacks/$name/data', path: 'data', label: 'Databases', blurb: 'Postgres, caches, search & vector', keywords: 'postgres database redis valkey cache meilisearch search qdrant pgvector vector' },
  { to: '/stacks/$name/studio', path: 'studio', label: 'Studio', blurb: 'Browse, edit and query the data', keywords: 'studio sql console table rows query' },
  { to: '/stacks/$name/queues', path: 'queues', label: 'Queues', blurb: 'BullMQ queues and their workers', keywords: 'queues bullmq workers jobs failed retries dlq' },
];

export const OBS_SUBS: StackSubTab[] = [
  { to: '/stacks/$name/observability', path: 'observability', label: 'Logs & traces', blurb: 'Logs, metrics, traces & status page', keywords: 'logs metrics traces otel telemetry service map status page uptime', systemSafe: true },
  { to: '/stacks/$name/replays', path: 'replays', label: 'Replays', blurb: 'Session replays of real visits', keywords: 'session replay recordings rrweb' },
  { to: '/stacks/$name/errors', path: 'errors', label: 'Errors', blurb: 'Sentry-compatible error tracking', keywords: 'errors exceptions issues sentry dsn crashes stack trace' },
  { to: '/stacks/$name/analytics', path: 'analytics', label: 'Analytics', blurb: 'Visitors, pages & web vitals, counted at the edge', keywords: 'rum analytics visitors pageviews referrers web vitals' },
  { to: '/stacks/$name/rum-settings', path: 'rum-settings', label: 'Settings', blurb: 'Replay & analytics settings', keywords: 'replay analytics settings masking consent retention sampling' },
];

export const CONFIG_SUBS: StackSubTab[] = [
  { to: '/stacks/$name/config', path: 'config', exact: true, label: 'Variables & secrets', blurb: 'Variables, secrets & config files', keywords: 'env variables secrets rotation configs env files' },
  { to: '/stacks/$name/config/scaling', path: 'config/scaling', label: 'Scaling', blurb: 'Copies, and the app’s own settings', keywords: 'copies replicas scale rename ai gateway outlet environment danger remove delete' },
  { to: '/stacks/$name/config/rollout', path: 'config/rollout', label: 'Health & rollout', blurb: 'Health watch, auto put-back & canary', keywords: 'safety health gate canary strategy rolling blue green auto rollback' },
  { to: '/stacks/$name/config/placement', path: 'config/placement', label: 'Placement & volumes', blurb: 'Which servers each part may run on', keywords: 'placement constraints pinned servers regions volumes' },
  { to: '/stacks/$name/config/jobs', path: 'config/jobs', label: 'Jobs & previews', blurb: 'Scheduled jobs, webhooks & branch previews', keywords: 'cron scheduled jobs webhooks endpoints deliveries outbound previews branches pr' },
];
