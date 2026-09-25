import {
  ActivityIcon,
  ArchiveIcon,
  ArrowUpCircleIcon,
  BellIcon,
  BoxesIcon,
  CircleDollarSignIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutDashboardIcon,
  LayoutTemplateIcon,
  MailIcon,
  NetworkIcon,
  PackageIcon,
  RocketIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SirenIcon,
  SparklesIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The single source of truth for every navigable GLOBAL destination.
 *
 * Calm Layers IA (plans/redesign-build.md): seven flat nav rows — Overview ·
 * Apps · Servers · Network · Data │ Activity · Settings. Each row's pages are
 * in-page tabs (`SECTIONS` by group), never extra nav rows. Deploy is a verb
 * (the coral "Deploy an app" + ⌘K), not a row. Anything that belongs to one
 * app lives inside its workspace (`/stacks/$name`, `lib/stack-nav.ts`).
 * URLs are unchanged from the old IA; only the grouping moved.
 */

export type DestinationGroup =
  | 'Overview'
  | 'Apps'
  | 'Servers'
  | 'Network'
  | 'Data'
  | 'Activity'
  | 'Settings'
  | 'Deploy';

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

/** The seven nav rows, as palette/mobile "go to" destinations. */
export const PRIMARY: Destination[] = [
  { to: '/overview', label: 'Overview', icon: LayoutDashboardIcon, group: 'Overview', blurb: 'Is everything calm, and what needs you', keywords: 'home dashboard summary health status estate start', exact: true },
  { to: '/', label: 'Apps', icon: BoxesIcon, group: 'Apps', blurb: 'Your apps — everything they need lives inside', keywords: 'apps applications services stacks canvas map databases caches queues jobs webhooks logs errors analytics replays secrets variables releases', exact: true },
  { to: '/nodes', label: 'Servers', icon: ServerIcon, group: 'Servers', blurb: 'The machines your apps run on', keywords: 'nodes cluster machines hosts servers capacity regions add server', badge: 'nodesOffline' },
  { to: '/network', label: 'Network', icon: GlobeIcon, group: 'Network', blurb: 'Domains, the front door, private network, email', keywords: 'domains dns https tls edge ingress caddy mesh private network geo email' },
  { to: '/data', label: 'Data', icon: DatabaseIcon, group: 'Data', blurb: 'Databases, storage, backups, AI', keywords: 'postgres database cache redis buckets s3 storage backups restore ai gateway' },
  { to: '/activity', label: 'Activity', icon: ActivityIcon, group: 'Activity', blurb: 'What happened, what’s firing, who did what', keywords: 'alerts incidents audit log history timeline cost' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, group: 'Settings', blurb: 'Workspace, people, keys, CI, upgrades', keywords: 'settings org members access sso api keys cli mcp ci registry platform upgrade' },
];

/** Every page, grouped by the nav row it belongs to. Order within a group is tab order. */
export const SECTIONS: Destination[] = [
  // ── Deploy (a verb: step tabs inside the deploy flow) ────────────────────
  { to: '/deploy', label: 'Choose', icon: RocketIcon, group: 'Deploy', blurb: 'Deploy an app: a template, your code, or an image', keywords: 'deploy new app create start', exact: true },
  { to: '/blueprints', label: 'Templates', icon: LayoutTemplateIcon, group: 'Deploy', blurb: 'One-click apps', keywords: 'templates blueprints gallery starter wordpress n8n directus one-click marketplace' },
  { to: '/stacks/new', label: 'Compose file', icon: LayersIcon, group: 'Deploy', blurb: 'Paste a compose file or swarmy.yaml', keywords: 'compose yaml stack bundle' },
  { to: '/services/new', label: 'One image', icon: PackageIcon, group: 'Deploy', blurb: 'Run a single container image', keywords: 'image container docker run' },

  // ── Network ─────────────────────────────────────────────────────────────
  { to: '/network', label: 'Domains', icon: GlobeIcon, group: 'Network', blurb: 'Every address, which app it opens, HTTPS', keywords: 'domains hostnames dns https certificates geo', exact: true },
  { to: '/ingress', label: 'Front door', icon: NetworkIcon, group: 'Network', blurb: 'The edge servers visitors reach first', keywords: 'caddy driver tls https edge ingress tunnel cloudflare protection' },
  { to: '/networking', label: 'Private network', icon: ShieldIcon, group: 'Network', blurb: 'Servers and laptops on one private network', keywords: 'mesh wireguard overlay peers routes acl netbird zero trust laptop' },
  { to: '/email', label: 'Email', icon: MailIcon, group: 'Network', blurb: 'Send mail from your domains', keywords: 'email smtp mail dkim spf dmarc send bounces suppressions templates relay' },

  // ── Data ────────────────────────────────────────────────────────────────
  { to: '/data', label: 'All data', icon: DatabaseIcon, group: 'Data', blurb: 'Every database, cache and bucket, and whether it’s safe', keywords: 'postgres database cache search vector managed data', exact: true },
  { to: '/data/buckets', label: 'Files & buckets', icon: ArchiveIcon, group: 'Data', blurb: 'S3 buckets on your servers', keywords: 's3 object storage garage buckets keys minio' },
  { to: '/backups', label: 'Backups', icon: DatabaseBackupIcon, group: 'Data', blurb: 'Where backups go, restores, swarmy’s own backup', keywords: 'targets restic s3 destinations snapshots volumes restore dr controller bundle dump' },
  { to: '/ai', label: 'AI gateway', icon: SparklesIcon, group: 'Data', blurb: 'Providers, keys, usage, playground', keywords: 'llm anthropic openai openrouter models virtual keys usage tokens embeddings gateway playground' },

  // ── Activity ────────────────────────────────────────────────────────────
  { to: '/activity', label: 'Timeline', icon: ActivityIcon, group: 'Activity', blurb: 'Everything that happened, newest first', keywords: 'timeline history feed changes deploys', exact: true },
  { to: '/alerts', label: 'Alerts', icon: BellIcon, group: 'Activity', blurb: 'What’s firing, rules and where they go', keywords: 'rules channels notifications firing resolved slack email discord thresholds', badge: 'alertsFiring' },
  { to: '/incidents', label: 'Incidents', icon: SirenIcon, group: 'Activity', blurb: 'Open and past incidents', keywords: 'outage timeline postmortem resolved downtime', badge: 'incidentsOpen' },
  { to: '/audit', label: 'Audit log', icon: ScrollTextIcon, group: 'Activity', blurb: 'Who did what, exportable', keywords: 'compliance who did what history export actions' },
  { to: '/cost', label: 'Cost', icon: CircleDollarSignIcon, group: 'Activity', blurb: 'Spend, budgets and savings', keywords: 'spend usd budgets utilization idle savings recommendations capacity billing' },

  // ── Settings ────────────────────────────────────────────────────────────
  { to: '/settings', label: 'Workspace', icon: SettingsIcon, group: 'Settings', blurb: 'Name, preferences, your own security', keywords: 'settings org profile general preferences two factor 2fa passkey security', exact: true },
  { to: '/settings/access', label: 'People & access', icon: ShieldIcon, group: 'Settings', blurb: 'Members, roles, SSO', keywords: 'rbac abac members sso policies roles access invite google okta' },
  { to: '/governance', label: 'Guardrails', icon: ShieldCheckIcon, group: 'Settings', blurb: 'Rules every deploy is checked against', keywords: 'governance guardrails policies production safety rules blocked exposure public private ports' },
  { to: '/settings/api-keys', label: 'API, CLI & MCP', icon: KeyRoundIcon, group: 'Settings', blurb: 'Keys for the API, CLI, Terraform and AI agents', keywords: 'tokens oauth terraform api keys cli mcp' },
  { to: '/ci', label: 'CI & registry', icon: GitBranchIcon, group: 'Settings', blurb: 'Git → build → registry', keywords: 'git pipelines builds registry images previews' },
  { to: '/settings/platform', label: 'Platform & upgrades', icon: ArrowUpCircleIcon, group: 'Settings', blurb: 'swarmy version and one-button upgrade', keywords: 'upgrade version release channel stable edge maintenance update controller agents store' },
];

export const ALL_DESTINATIONS: Destination[] = [...PRIMARY, ...SECTIONS.filter((s) => !PRIMARY.some((p) => p.to === s.to))];

/** Palette / mobile-sheet group order for the tabbed rows. */
export const NAV_GROUP_ORDER: DestinationGroup[] = ['Deploy', 'Network', 'Data', 'Activity', 'Settings'];

/** A sidenav row. `divider` draws the hairline above it (Activity starts the lower group). */
export interface NavGroup {
  group: Exclude<DestinationGroup, 'Deploy'>;
  label: string;
  icon: LucideIcon;
  to: string;
  /** Child badge signals summed into the row's attention count. */
  badges: BadgeKey[];
  divider?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  { group: 'Overview', label: 'Overview', icon: LayoutDashboardIcon, to: '/overview', badges: [] },
  { group: 'Apps', label: 'Apps', icon: BoxesIcon, to: '/', badges: [] },
  { group: 'Servers', label: 'Servers', icon: ServerIcon, to: '/nodes', badges: ['nodesOffline'] },
  { group: 'Network', label: 'Network', icon: GlobeIcon, to: '/network', badges: [] },
  { group: 'Data', label: 'Data', icon: DatabaseIcon, to: '/data', badges: [] },
  { group: 'Activity', label: 'Activity', icon: BellIcon, to: '/activity', badges: ['alertsFiring', 'incidentsOpen'], divider: true },
  { group: 'Settings', label: 'Settings', icon: SettingsIcon, to: '/settings', badges: [] },
];

/** Prefixes that belong to a row without being one of its tabs. */
const PREFIX_GROUP: [string, DestinationGroup][] = [
  ['/stacks/new', 'Deploy'],
  ['/services/new', 'Deploy'],
  ['/stacks', 'Apps'],
  ['/services', 'Apps'],
  ['/observability', 'Apps'],
  ['/terminal', 'Apps'],
  ['/nodes', 'Servers'],
  ['/incidents', 'Activity'],
  ['/ci', 'Settings'],
  ['/device', 'Settings'],
];

/** The group a pathname belongs to — most-specific destination match wins. */
export function groupForPathname(pathname: string): DestinationGroup | null {
  const matches = ALL_DESTINATIONS.filter((d) =>
    d.exact ? pathname === d.to : pathname === d.to || pathname.startsWith(`${d.to}/`),
  );
  const best = matches.sort((a, b) => b.to.length - a.to.length)[0];
  const prefix = PREFIX_GROUP.find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  if (prefix && (!best || prefix[0].length >= best.to.length)) return prefix[1];
  return best?.group ?? null;
}

/** The nav row lit for a pathname (Deploy pages light Apps). */
export function navRowForPathname(pathname: string): NavGroup['group'] | null {
  const g = groupForPathname(pathname);
  return g === 'Deploy' ? 'Apps' : g;
}

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
  { id: 'deploy', label: 'Deploy an app', to: '/deploy', icon: RocketIcon, kind: 'deploy', keywords: 'create new app start deploy' },
  { id: 'blueprint', label: 'Start from a template', to: '/blueprints', icon: LayoutTemplateIcon, kind: 'deploy', keywords: 'template blueprint one-click wordpress n8n' },
  { id: 'deploy-stack', label: 'Deploy a compose file', to: '/stacks/new', icon: LayersIcon, kind: 'deploy', keywords: 'compose yaml stack bundle' },
  { id: 'new-service', label: 'Run one image', to: '/services/new', icon: PackageIcon, kind: 'deploy', keywords: 'create add run container image' },
  { id: 'new-bucket', label: 'Create a bucket', to: '/data/buckets', icon: ArchiveIcon, kind: 'data', keywords: 's3 object storage bucket' },
  { id: 'add-node', label: 'Add a server', to: '/nodes/new', icon: ServerIcon, kind: 'infra', keywords: 'enrol join install agent host machine' },
];

/** Human labels for the Create-menu groups. */
export const CREATE_KIND_LABEL: Record<CommandAction['kind'], string> = {
  deploy: 'Deploy',
  data: 'Data services',
  ops: 'Operations',
  infra: 'Servers',
};
