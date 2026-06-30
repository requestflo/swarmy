import {
  ActivityIcon,
  BoxesIcon,
  DatabaseBackupIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  NetworkIcon,
  PackageIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  WandSparklesIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The single source of truth for every navigable destination in the dashboard.
 *
 * The redesign drops the 15-item sidenav. Navigation now flows through two
 * primary *planes* (Applications / Infrastructure) shown as tabs in the command
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
    label: 'Applications',
    icon: BoxesIcon,
    group: 'Planes',
    keywords: 'apps services stacks canvas deploy graph architecture',
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
  { to: '/stacks', label: 'Stacks', icon: LayersIcon, group: 'Deploy', keywords: 'compose bundles groups' },
  { to: '/services/builder', label: 'Service builder', icon: WandSparklesIcon, group: 'Deploy', keywords: 'gui compose builder visual' },
  { to: '/ingress', label: 'Ingress', icon: NetworkIcon, group: 'Networking', keywords: 'domains routes tls caddy reverse proxy' },
  { to: '/networking', label: 'Mesh networking', icon: GlobeIcon, group: 'Networking', keywords: 'mesh wireguard overlay peers routes acl' },
  { to: '/geo', label: 'Geo DNS', icon: GlobeIcon, group: 'Networking', keywords: 'dns geo steering failover records' },
  { to: '/geo/dns', label: 'DNS health', icon: GlobeIcon, group: 'Networking', keywords: 'dns resolve probe health endpoints reachable geodns' },
  { to: '/ci', label: 'CI & builds', icon: GitBranchIcon, group: 'Delivery', keywords: 'git pipelines builds registry images' },
  { to: '/backups', label: 'Backups', icon: DatabaseBackupIcon, group: 'Data', keywords: 'volumes snapshots restore restic' },
  { to: '/backups/schedules', label: 'DR & schedules', icon: ShieldIcon, group: 'Data', keywords: 'disaster recovery schedules cron' },
  { to: '/settings/backup', label: 'Controller backup', icon: DatabaseBackupIcon, group: 'Data', keywords: 'control plane bundle dump restore' },
  { to: '/observability', label: 'Observability', icon: ActivityIcon, group: 'Observability', keywords: 'traces logs metrics otel telemetry' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, group: 'Settings', keywords: 'org profile general preferences' },
  { to: '/settings/access', label: 'Access & roles', icon: ShieldIcon, group: 'Settings', keywords: 'rbac abac members sso policies' },
  { to: '/settings/api-keys', label: 'API keys', icon: KeyRoundIcon, group: 'Settings', keywords: 'tokens swk oauth terraform' },
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
