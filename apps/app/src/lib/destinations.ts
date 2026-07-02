import {
  ActivityIcon,
  ArchiveIcon,
  BellIcon,
  BoxesIcon,
  BoxIcon,
  ClockIcon,
  CircleDollarSignIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  FileCogIcon,
  GitBranchIcon,
  GlobeIcon,
  HeartPulseIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutTemplateIcon,
  LifeBuoyIcon,
  ListOrderedIcon,
  LockKeyholeIcon,
  MailIcon,
  NetworkIcon,
  PackageIcon,
  RadioTowerIcon,
  RocketIcon,
  ScrollTextIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SirenIcon,
  SparklesIcon,
  WandSparklesIcon,
  WebhookIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The single source of truth for every navigable destination in the dashboard.
 *
 * Navigation is a grouped left sidenav (desktop) + a grouped sheet (mobile),
 * both driven by this registry, plus the ⌘K palette. A new page is added in
 * exactly one place: append a `Destination` here and it appears in the sidenav,
 * the mobile sheet, and the palette automatically.
 */

export type DestinationGroup =
  | 'Primary'
  | 'Deploy'
  | 'Data'
  | 'Operations'
  | 'Network'
  | 'Protection'
  | 'Governance'
  | 'Settings';

/** A live attention count resolved in the shell. */
export type BadgeKey = 'nodesOffline' | 'alertsFiring' | 'incidentsOpen';

export interface Destination {
  to: string;
  label: string;
  icon: LucideIcon;
  group: DestinationGroup;
  /** One-line explainer under the label (mobile sheet + palette hint). */
  blurb?: string;
  /** Keywords to widen palette fuzzy-search beyond the label. */
  keywords?: string;
  /** Exact-match active styling (for index routes). */
  exact?: boolean;
  /** Live attention badge rendered beside the item. */
  badge?: BadgeKey;
}

/**
 * The three always-visible anchors, above the grouped sections with no header:
 * where you land, your apps, your cluster.
 */
export const PRIMARY: Destination[] = [
  {
    to: '/overview',
    label: 'Overview',
    icon: LayoutDashboardIcon,
    group: 'Primary',
    blurb: 'Estate health at a glance',
    keywords: 'home dashboard summary health status estate start',
    exact: true,
  },
  {
    to: '/',
    label: 'Stacks',
    icon: BoxesIcon,
    group: 'Primary',
    blurb: 'Your apps on a live canvas',
    keywords: 'apps applications services stacks canvas deploy graph architecture',
    exact: true,
  },
  {
    to: '/nodes',
    label: 'Infrastructure',
    icon: ServerIcon,
    group: 'Primary',
    blurb: 'The cluster and its nodes',
    keywords: 'nodes cluster machines hosts servers capacity',
  },
];

/** The two primary planes — kept for the ⌘K palette + plane-aware surfaces. */
export const PLANES: Destination[] = PRIMARY.filter((d) => d.to === '/' || d.to === '/nodes');

/** Every grouped destination. Order within a group is display order. */
export const SECTIONS: Destination[] = [
  // ── Deploy ──────────────────────────────────────────────────────────────
  { to: '/stacks', label: 'Deploy from compose', icon: LayersIcon, group: 'Deploy', blurb: 'Paste a compose file', keywords: 'compose bundles groups stacks yaml' },
  { to: '/services/builder', label: 'Service builder', icon: WandSparklesIcon, group: 'Deploy', blurb: 'Build a service visually', keywords: 'gui compose builder visual' },
  { to: '/blueprints', label: 'Blueprints', icon: LayoutTemplateIcon, group: 'Deploy', blurb: 'One-click swarmy-native stacks', keywords: 'templates gallery starter wordpress n8n directus one-click marketplace' },
  { to: '/ci', label: 'CI & builds', icon: GitBranchIcon, group: 'Deploy', blurb: 'Git → build → registry', keywords: 'git pipelines builds registry images previews' },
  { to: '/releases', label: 'Releases', icon: RocketIcon, group: 'Deploy', blurb: 'History, health gates, rollback', keywords: 'deploys history rollback canary blue green health gates strategy' },

  // ── Data ────────────────────────────────────────────────────────────────
  { to: '/data', label: 'Databases', icon: DatabaseIcon, group: 'Data', blurb: 'Managed Postgres, HA & PITR', keywords: 'postgres database managed ha pitr replica failover' },
  { to: '/data/cache', label: 'Caches', icon: ZapIcon, group: 'Data', blurb: 'Redis / Valkey, single to HA', keywords: 'redis valkey cache sentinel memory sessions queue' },
  { to: '/data/buckets', label: 'Buckets', icon: ArchiveIcon, group: 'Data', blurb: 'S3 object storage on your nodes', keywords: 's3 object storage garage buckets keys minio' },
  { to: '/data/search', label: 'Search', icon: SearchIcon, group: 'Data', blurb: 'Meilisearch / Typesense', keywords: 'search meilisearch typesense index full text' },
  { to: '/data/vector', label: 'Vector stores', icon: BoxIcon, group: 'Data', blurb: 'Qdrant / pgvector', keywords: 'vector qdrant pgvector embeddings ai rag' },
  { to: '/ai', label: 'AI gateway', icon: SparklesIcon, group: 'Data', blurb: 'Route, key & meter LLM calls', keywords: 'llm anthropic openai openrouter models virtual keys usage tokens embeddings' },

  // ── Operations ──────────────────────────────────────────────────────────
  { to: '/observability', label: 'Observability', icon: ActivityIcon, group: 'Operations', blurb: 'Logs, metrics, traces, maps', keywords: 'traces logs metrics otel telemetry service map health' },
  { to: '/alerts', label: 'Alerts', icon: BellIcon, group: 'Operations', blurb: 'Rules, channels, firing events', keywords: 'rules channels notifications firing resolved slack email teams thresholds', badge: 'alertsFiring' },
  { to: '/incidents', label: 'Incidents', icon: SirenIcon, group: 'Operations', blurb: 'Timelines of what happened', keywords: 'outage timeline postmortem resolved downtime', badge: 'incidentsOpen' },
  { to: '/jobs', label: 'Scheduled jobs', icon: ClockIcon, group: 'Operations', blurb: 'Cron for your workloads', keywords: 'cron scheduled tasks runs one-shot output nightly' },
  { to: '/queues', label: 'Queues', icon: ListOrderedIcon, group: 'Operations', blurb: 'Depth, workers, dead-letters', keywords: 'bullmq workers depth dlq dead letter retry scale backlog' },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, group: 'Operations', blurb: 'Durable multi-step pipelines', keywords: 'automation steps approvals pipelines runs delays durable orchestration' },
  { to: '/webhooks', label: 'Webhooks', icon: WebhookIcon, group: 'Operations', blurb: 'Receive, verify, retry, replay', keywords: 'inbound outbound endpoints deliveries events hmac github stripe replay gateway' },
  { to: '/status-pages', label: 'Status pages', icon: RadioTowerIcon, group: 'Operations', blurb: 'Public uptime for customers', keywords: 'public uptime components status page subscribe incidents' },

  // ── Network ─────────────────────────────────────────────────────────────
  { to: '/ingress', label: 'Ingress', icon: NetworkIcon, group: 'Network', blurb: 'Domains, routes, auto-HTTPS', keywords: 'domains routes tls caddy reverse proxy https' },
  { to: '/networking', label: 'Mesh', icon: GlobeIcon, group: 'Network', blurb: 'WireGuard overlay & peers', keywords: 'mesh wireguard overlay peers routes acl netbird zero trust' },
  { to: '/geo', label: 'Geo DNS', icon: GlobeIcon, group: 'Network', blurb: 'GSLB & regional steering', keywords: 'dns geo steering failover records region latency' },
  { to: '/geo/dns', label: 'DNS health', icon: HeartPulseIcon, group: 'Network', blurb: 'Live record & endpoint health', keywords: 'dns resolve probe health endpoints reachable geodns' },
  { to: '/exposure', label: 'Exposure', icon: ShieldAlertIcon, group: 'Network', blurb: 'Public vs private, enforced', keywords: 'public private protected ports attack surface audit violations firewall' },

  // ── Protection ──────────────────────────────────────────────────────────
  { to: '/backups', label: 'Backups', icon: DatabaseBackupIcon, group: 'Protection', blurb: 'Volume snapshots & restore', keywords: 'volumes snapshots restore restic backup' },
  { to: '/backups/schedules', label: 'DR & schedules', icon: ShieldIcon, group: 'Protection', blurb: 'Disaster-recovery schedules', keywords: 'disaster recovery schedules cron dr' },
  { to: '/resilience', label: 'Resilience', icon: LifeBuoyIcon, group: 'Protection', blurb: 'Score & safe recovery drills', keywords: 'score drills failover restore readiness dr chaos rpo rto' },
  { to: '/settings/backup', label: 'Controller backup', icon: DatabaseBackupIcon, group: 'Protection', blurb: 'Back up swarmy itself', keywords: 'control plane bundle dump restore passphrase' },

  // ── Governance ──────────────────────────────────────────────────────────
  { to: '/secrets', label: 'Secrets', icon: LockKeyholeIcon, group: 'Governance', blurb: 'Docker secrets & rotation', keywords: 'docker secrets rotation versions credentials vault' },
  { to: '/configs', label: 'Configs', icon: FileCogIcon, group: 'Governance', blurb: 'Non-secret config & rollback', keywords: 'docker configs versions diff rollout files rollback' },
  { to: '/governance', label: 'Guardrails', icon: ShieldCheckIcon, group: 'Governance', blurb: 'Production safety rules', keywords: 'governance policies production safety rules blocked overrides opa admission' },
  { to: '/settings/access', label: 'Access & roles', icon: ShieldIcon, group: 'Governance', blurb: 'RBAC / ABAC & members', keywords: 'rbac abac members sso policies roles access' },
  { to: '/audit', label: 'Audit log', icon: ScrollTextIcon, group: 'Governance', blurb: 'Who did what, exportable', keywords: 'compliance who did what history export actions' },
  { to: '/cost', label: 'Cost & capacity', icon: CircleDollarSignIcon, group: 'Governance', blurb: 'Spend & right-sizing tips', keywords: 'spend usd nodes utilization idle savings recommendations capacity' },

  // ── Settings ────────────────────────────────────────────────────────────
  { to: '/settings', label: 'Settings', icon: SettingsIcon, group: 'Settings', blurb: 'Org profile & preferences', keywords: 'org profile general preferences' },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRoundIcon, group: 'Settings', blurb: 'Tokens for the API & Terraform', keywords: 'tokens swk oauth terraform api keys' },
  { to: '/settings/notifications', label: 'Notifications', icon: MailIcon, group: 'Settings', blurb: 'Email / SMTP delivery', keywords: 'email smtp resend postmark mailgun templates delivery' },
];

export const ALL_DESTINATIONS: Destination[] = [...PRIMARY, ...SECTIONS];

/** Sidenav / palette group order (Primary is rendered separately, headerless). */
export const NAV_GROUP_ORDER: DestinationGroup[] = [
  'Deploy',
  'Data',
  'Operations',
  'Network',
  'Protection',
  'Governance',
  'Settings',
];

/** Quick-action verbs surfaced in the palette + the global Create menu. */
export interface CommandAction {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  keywords?: string;
  /** Grouping in the Create menu. */
  kind: 'deploy' | 'data' | 'ops' | 'infra';
}

export const QUICK_ACTIONS: CommandAction[] = [
  { id: 'new-service', label: 'Deploy a service', to: '/services/new', icon: PackageIcon, kind: 'deploy', keywords: 'create add run container deploy' },
  { id: 'deploy-stack', label: 'Deploy from compose', to: '/stacks', icon: LayersIcon, kind: 'deploy', keywords: 'compose yaml stack bundle' },
  { id: 'blueprint', label: 'Start from a blueprint', to: '/blueprints', icon: LayoutTemplateIcon, kind: 'deploy', keywords: 'template one-click wordpress n8n' },
  { id: 'new-database', label: 'Provision a database', to: '/data', icon: DatabaseIcon, kind: 'data', keywords: 'postgres db managed' },
  { id: 'new-cache', label: 'Provision a cache', to: '/data/cache', icon: ZapIcon, kind: 'data', keywords: 'redis valkey cache' },
  { id: 'new-bucket', label: 'Create a bucket', to: '/data/buckets', icon: ArchiveIcon, kind: 'data', keywords: 's3 object storage bucket' },
  { id: 'new-job', label: 'Schedule a job', to: '/jobs', icon: ClockIcon, kind: 'ops', keywords: 'cron job scheduled' },
  { id: 'new-workflow', label: 'Build a workflow', to: '/workflows', icon: WorkflowIcon, kind: 'ops', keywords: 'workflow pipeline durable' },
  { id: 'new-status-page', label: 'Create a status page', to: '/status-pages', icon: RadioTowerIcon, kind: 'ops', keywords: 'status uptime public' },
  { id: 'add-node', label: 'Add a node', to: '/nodes/new', icon: ServerIcon, kind: 'infra', keywords: 'enrol join install agent host machine' },
  { id: 'add-domain', label: 'Add a domain', to: '/ingress', icon: NetworkIcon, kind: 'infra', keywords: 'domain route ingress tls https' },
];

/** Human labels for the Create-menu groups. */
export const CREATE_KIND_LABEL: Record<CommandAction['kind'], string> = {
  deploy: 'Deploy',
  data: 'Data services',
  ops: 'Operations',
  infra: 'Infrastructure',
};

/** The status tone a badge count renders with. */
export const BADGE_TONE: Record<BadgeKey, string> = {
  nodesOffline: 'offline',
  alertsFiring: 'warning',
  incidentsOpen: 'offline',
};
