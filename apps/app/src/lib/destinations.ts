import {
  ArchiveIcon,
  BellIcon,
  BoxesIcon,
  CircleDollarSignIcon,
  DatabaseBackupIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutTemplateIcon,
  MailIcon,
  PackageIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SirenIcon,
  SparklesIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The single source of truth for every navigable GLOBAL destination.
 *
 * The global sidenav is deliberately slim: estate-level concerns only. Anything
 * that belongs to an app — databases, caches, queues, workflows, webhooks,
 * observability, secrets, configs, ingress, backups-setup, resilience, status
 * pages, releases — lives INSIDE the stack workspace (`/stacks/$name`, see
 * `lib/stack-nav.ts`), not here. A stack is the unit you operate; the estate is
 * what you keep an eye on.
 */

export type DestinationGroup =
  | 'Primary'
  | 'Deploy'
  | 'Platform'
  | 'Operations'
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
    blurb: 'Your apps — everything they need lives inside',
    keywords:
      'apps applications services stacks canvas deploy graph architecture databases caches queues workflows webhooks observability secrets configs ingress backups releases',
    exact: true,
  },
  {
    to: '/nodes',
    label: 'Infrastructure',
    icon: ServerIcon,
    group: 'Primary',
    blurb: 'The cluster and its nodes',
    keywords: 'nodes cluster machines hosts servers capacity regions',
    badge: 'nodesOffline',
  },
];

/** The two primary planes — kept for the ⌘K palette + plane-aware surfaces. */
export const PLANES: Destination[] = PRIMARY.filter((d) => d.to === '/' || d.to === '/nodes');

/** Every grouped destination. Order within a group is display order. */
export const SECTIONS: Destination[] = [
  // ── Deploy ──────────────────────────────────────────────────────────────
  { to: '/blueprints', label: 'Blueprints', icon: LayoutTemplateIcon, group: 'Deploy', blurb: 'One-click swarmy-native stacks', keywords: 'templates gallery starter wordpress n8n directus one-click marketplace' },
  { to: '/ci', label: 'CI & builds', icon: GitBranchIcon, group: 'Deploy', blurb: 'Git → build → registry', keywords: 'git pipelines builds registry images previews' },

  // ── Platform (global, estate-level services) ────────────────────────────
  { to: '/data/buckets', label: 'Object storage', icon: ArchiveIcon, group: 'Platform', blurb: 'S3 buckets on your nodes', keywords: 's3 object storage garage buckets keys minio' },
  { to: '/networking', label: 'Mesh', icon: GlobeIcon, group: 'Platform', blurb: 'WireGuard overlay & peers', keywords: 'mesh wireguard overlay peers routes acl netbird zero trust' },
  { to: '/ai', label: 'AI gateway', icon: SparklesIcon, group: 'Platform', blurb: 'Providers, keys & metering', keywords: 'llm anthropic openai openrouter models virtual keys usage tokens embeddings gateway' },
  { to: '/backups', label: 'Backup destinations', icon: DatabaseBackupIcon, group: 'Platform', blurb: 'Where backups go — incl. your own buckets', keywords: 'targets restic s3 destinations snapshots volumes restore dr' },
  { to: '/settings/backup', label: 'Controller backup', icon: ShieldIcon, group: 'Platform', blurb: 'Back up swarmy itself', keywords: 'control plane bundle dump restore passphrase' },

  // ── Operations (cross-stack rollup; full controls live per-stack) ───────
  { to: '/alerts', label: 'Alerts', icon: BellIcon, group: 'Operations', blurb: 'Everything firing, estate-wide', keywords: 'rules channels notifications firing resolved slack email teams thresholds', badge: 'alertsFiring' },
  { to: '/incidents', label: 'Incidents', icon: SirenIcon, group: 'Operations', blurb: 'Open incidents across all stacks', keywords: 'outage timeline postmortem resolved downtime', badge: 'incidentsOpen' },

  // ── Governance ──────────────────────────────────────────────────────────
  { to: '/governance', label: 'Guardrails', icon: ShieldCheckIcon, group: 'Governance', blurb: 'Production safety rules', keywords: 'governance policies production safety rules blocked overrides opa admission' },
  { to: '/exposure', label: 'Exposure', icon: ShieldAlertIcon, group: 'Governance', blurb: 'Public vs private, enforced', keywords: 'public private protected ports attack surface audit violations firewall' },
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
  'Platform',
  'Operations',
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
  { id: 'new-bucket', label: 'Create a bucket', to: '/data/buckets', icon: ArchiveIcon, kind: 'data', keywords: 's3 object storage bucket' },
  { id: 'add-node', label: 'Add a node', to: '/nodes/new', icon: ServerIcon, kind: 'infra', keywords: 'enrol join install agent host machine' },
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
