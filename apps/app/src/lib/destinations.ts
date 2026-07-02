import {
  ActivityIcon,
  BellIcon,
  BoxesIcon,
  CalendarClockIcon,
  CircleDollarSignIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  FileCogIcon,
  GitBranchIcon,
  GlobeIcon,
  HeartPulseIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutTemplateIcon,
  ListOrderedIcon,
  LockKeyholeIcon,
  MailIcon,
  NetworkIcon,
  PackageIcon,
  RadioTowerIcon,
  RocketIcon,
  ScrollTextIcon,
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
  type LucideIcon,
} from 'lucide-react';

/**
 * The single source of truth for every navigable destination in the dashboard.
 *
 * The redesign drops the 15-item sidenav. Navigation now flows through two
 * primary *planes* (Stacks / Infrastructure) shown as tabs in the command
 * bar, plus the ⌘K command palette + a top-bar overflow that group everything
 * else. Both consume this registry so a new page is added in exactly one place.
 */

export type DestinationGroup =
  | 'Planes'
  | 'Deploy'
  | 'Networking'
  | 'Delivery'
  | 'Data'
  | 'Observability'
  | 'Operations'
  | 'Network'
  | 'Protection'
  | 'Governance'
  | 'Settings';

export interface Destination {
  to: string;
  label: string;
  icon: LucideIcon;
  group: DestinationGroup;
  /** Keywords to widen palette fuzzy-search beyond the label. */
  keywords?: string;
  /** Exact-match active styling (for index routes). */
  exact?: boolean;
}

/** The two primary planes — the conceptual split: run-your-apps vs the cluster. */
export const PLANES: Destination[] = [
  {
    to: '/',
    label: 'Stacks',
    icon: BoxesIcon,
    group: 'Planes',
    keywords: 'apps applications services stacks canvas deploy graph architecture',
    exact: true,
  },
  {
    to: '/nodes',
    label: 'Infrastructure',
    icon: ServerIcon,
    group: 'Planes',
    keywords: 'nodes cluster machines hosts servers capacity',
  },
];

/** Everything else, grouped. Reachable from ⌘K and the top-bar overflow. */
export const SECTIONS: Destination[] = [
  { to: '/stacks', label: 'Deploy from compose', icon: LayersIcon, group: 'Deploy', keywords: 'compose bundles groups stacks yaml' },
  { to: '/services/builder', label: 'Service builder', icon: WandSparklesIcon, group: 'Deploy', keywords: 'gui compose builder visual' },
  { to: '/blueprints', label: 'Blueprints', icon: LayoutTemplateIcon, group: 'Deploy', keywords: 'templates gallery starter wordpress n8n directus one-click stacks' },
  { to: '/ingress', label: 'Ingress', icon: NetworkIcon, group: 'Networking', keywords: 'domains routes tls caddy reverse proxy' },
  { to: '/networking', label: 'Mesh networking', icon: GlobeIcon, group: 'Networking', keywords: 'mesh wireguard overlay peers routes acl' },
  { to: '/geo', label: 'Geo DNS', icon: GlobeIcon, group: 'Networking', keywords: 'dns geo steering failover records' },
  { to: '/geo/dns', label: 'DNS health', icon: GlobeIcon, group: 'Networking', keywords: 'dns resolve probe health endpoints reachable geodns' },
  { to: '/exposure', label: 'Exposure', icon: ShieldAlertIcon, group: 'Network', keywords: 'public private protected ports attack surface audit violations' },
  { to: '/ci', label: 'CI & builds', icon: GitBranchIcon, group: 'Delivery', keywords: 'git pipelines builds registry images previews' },
  { to: '/releases', label: 'Releases', icon: RocketIcon, group: 'Delivery', keywords: 'deploys history rollback canary blue green health gates' },
  { to: '/data', label: 'Data services', icon: DatabaseIcon, group: 'Data', keywords: 'databases postgres cache redis valkey search meilisearch typesense vector qdrant buckets s3 garage managed' },
  { to: '/ai', label: 'AI gateway', icon: SparklesIcon, group: 'Data', keywords: 'llm anthropic openai openrouter models virtual keys usage tokens embeddings' },
  { to: '/backups', label: 'Backups', icon: DatabaseBackupIcon, group: 'Data', keywords: 'volumes snapshots restore restic' },
  { to: '/backups/schedules', label: 'DR & schedules', icon: ShieldIcon, group: 'Data', keywords: 'disaster recovery schedules cron' },
  { to: '/settings/backup', label: 'Controller backup', icon: DatabaseBackupIcon, group: 'Data', keywords: 'control plane bundle dump restore' },
  { to: '/resilience', label: 'Resilience', icon: HeartPulseIcon, group: 'Protection', keywords: 'score drills failover restore readiness dr chaos' },
  { to: '/observability', label: 'Observability', icon: ActivityIcon, group: 'Observability', keywords: 'traces logs metrics otel telemetry' },
  { to: '/alerts', label: 'Alerts', icon: BellIcon, group: 'Operations', keywords: 'rules channels notifications firing resolved slack email teams' },
  { to: '/incidents', label: 'Incidents', icon: SirenIcon, group: 'Operations', keywords: 'outage timeline postmortem resolved downtime' },
  { to: '/status-pages', label: 'Status pages', icon: RadioTowerIcon, group: 'Operations', keywords: 'public uptime components status page subscribe' },
  { to: '/queues', label: 'Queues', icon: ListOrderedIcon, group: 'Operations', keywords: 'bullmq workers depth dlq dead letter retry scale' },
  { to: '/jobs', label: 'Jobs', icon: CalendarClockIcon, group: 'Operations', keywords: 'cron scheduled tasks runs one-shot output' },
  { to: '/workflows', label: 'Workflows', icon: WorkflowIcon, group: 'Operations', keywords: 'automation steps approvals pipelines runs delays' },
  { to: '/webhooks', label: 'Webhooks', icon: WebhookIcon, group: 'Operations', keywords: 'inbound outbound endpoints deliveries events hmac github stripe replay' },
  { to: '/secrets', label: 'Secrets', icon: LockKeyholeIcon, group: 'Governance', keywords: 'docker secrets rotation versions credentials vault' },
  { to: '/configs', label: 'Configs', icon: FileCogIcon, group: 'Governance', keywords: 'docker configs versions diff rollout files' },
  { to: '/governance', label: 'Guardrails', icon: ShieldCheckIcon, group: 'Governance', keywords: 'governance policies production safety rules blocked overrides' },
  { to: '/audit', label: 'Audit log', icon: ScrollTextIcon, group: 'Governance', keywords: 'compliance who did what history export actions' },
  { to: '/cost', label: 'Cost', icon: CircleDollarSignIcon, group: 'Governance', keywords: 'spend usd nodes utilization idle savings recommendations' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, group: 'Settings', keywords: 'org profile general preferences' },
  { to: '/settings/access', label: 'Access & roles', icon: ShieldIcon, group: 'Settings', keywords: 'rbac abac members sso policies' },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRoundIcon, group: 'Settings', keywords: 'tokens swk oauth terraform' },
  { to: '/settings/notifications', label: 'Notifications', icon: MailIcon, group: 'Settings', keywords: 'email smtp resend postmark mailgun templates delivery' },
];

export const ALL_DESTINATIONS: Destination[] = [...PLANES, ...SECTIONS];

/** Quick-action verbs surfaced at the top of the palette (not pure navigation). */
export interface CommandAction {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  keywords?: string;
}

export const QUICK_ACTIONS: CommandAction[] = [
  { id: 'new-service', label: 'Deploy a new service', to: '/services/new', icon: PackageIcon, keywords: 'create add run container deploy' },
  { id: 'add-node', label: 'Add a node', to: '/nodes/new', icon: ServerIcon, keywords: 'enrol join install agent host machine' },
  { id: 'deploy-stack', label: 'Deploy from compose', to: '/stacks', icon: LayersIcon, keywords: 'compose yaml stack bundle' },
];
