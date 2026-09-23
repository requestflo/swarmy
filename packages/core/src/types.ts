/**
 * Non-Zod shared constants/labels used across the UI and services.
 * (Wire enums live in `@swarmy/core/protocol`.)
 */
import type { ExposureOverview, ExposureRowView } from './views';

export const INGRESS_DRIVERS = ['caddy', 'traefik', 'none', 'cloudflared', 'nginx', 'haproxy'] as const;
export type IngressDriverId = (typeof INGRESS_DRIVERS)[number];

export const INGRESS_DRIVER_LABELS: Record<IngressDriverId, string> = {
  caddy: 'Caddy',
  traefik: 'Traefik',
  none: 'None (self-managed)',
  cloudflared: 'Cloudflare Tunnel',
  nginx: 'nginx',
  haproxy: 'HAProxy',
};

export const NODE_STATUS_TONE: Record<string, 'online' | 'warning' | 'offline' | 'neutral'> = {
  online: 'online',
  draining: 'warning',
  degraded: 'warning',
  pending: 'neutral',
  offline: 'offline',
};

export const SERVICE_STATUS_TONE: Record<
  string,
  'online' | 'warning' | 'offline' | 'neutral' | 'progress'
> = {
  running: 'online',
  degraded: 'warning',
  deploying: 'progress',
  pending: 'neutral',
  stopped: 'neutral',
  removing: 'warning',
  failed: 'offline',
};

export const AGENT_VERSION = '0.1.0';

/** Token prefixes (see protocol §2). */
export const JOIN_TOKEN_PREFIX = 'swt';
export const SESSION_TOKEN_PREFIX = 'sst';

// ── Declared exposure intent (WS3) — the `swarmy.expose` service label ────────

/**
 * Service label carrying the DECLARED exposure intent (Docker truth, no DB row).
 * The inferred classifier verdict stays the *observed* half of the comparison;
 * this label is the *chosen* half. Absent label = undeclared (audit-only).
 */
export const EXPOSE_LABEL = 'swarmy.expose';

export const EXPOSE_MODES = ['public', 'tunnel', 'private', 'mesh'] as const;
/** Declared exposure intent: chosen in the UI, enforced at admission, drift-audited. */
export type ExposeMode = (typeof EXPOSE_MODES)[number];

/** Display names for the mode selector. */
export const EXPOSE_MODE_LABELS: Record<ExposeMode, string> = {
  public: 'Public',
  tunnel: 'Tunnel',
  private: 'Private',
  mesh: 'Mesh-only',
};

/** Parse a raw `swarmy.expose` label value; unknown/absent → null (undeclared). */
export function parseExposeMode(raw: string | null | undefined): ExposeMode | null {
  return raw != null && (EXPOSE_MODES as readonly string[]).includes(raw)
    ? (raw as ExposeMode)
    : null;
}

// ── Node data roles + install profiles (roadmap WS7) ─────────────────────────

/** This node hosts object-storage members (Garage placement prefers it). */
export const NODE_STORAGE_LABEL = 'swarmy.node.storage';
/** This node hosts managed databases (managed-DB placement prefers it). */
export const NODE_DATABASE_LABEL = 'swarmy.node.database';

// ── Builder capability (CI/CD) ───────────────────────────────────────────────

/**
 * This node runs CI builds (rootless BuildKit) and image GC. A Docker node
 * label like every other role — toggled from the node's role switches, read
 * live by the controller when it picks a builder, and asserted to the agent in
 * the `buildImage`/`pruneImages` payload (`builderCapable`).
 */
export const NODE_BUILDER_LABEL = 'swarmy.node.builder';
/** Pre-role-switch spelling (`swarmy.role=builder`) — still honoured on read. */
export const LEGACY_BUILDER_ROLE_LABEL = 'swarmy.role';

/**
 * The agent-local `SWARMY_ALLOW_BUILD` explicit override: `allow` forces builds
 * on regardless of the role label, `deny` forces them off (the node operator's
 * veto), `undefined` (unset) defers to the controller-managed builder role.
 */
export type BuildOverride = 'allow' | 'deny';

/** Parse a raw `SWARMY_ALLOW_BUILD` value; unset/empty/unknown → no override. */
export function parseBuildOverride(raw: string | null | undefined): BuildOverride | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return 'allow';
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return 'deny';
  return undefined;
}

/** Whether a node's live labels carry the builder role (new or legacy spelling). */
export function hasBuilderLabel(labels: Record<string, string> | undefined): boolean {
  return labels?.[NODE_BUILDER_LABEL] === 'true' || labels?.[LEGACY_BUILDER_ROLE_LABEL] === 'builder';
}

/**
 * Controller-side: can this node take a build? The agent's explicit override
 * (reported in its register facts) wins in both directions; otherwise the
 * builder role label decides.
 */
export function isBuilderCapable(
  labels: Record<string, string> | undefined,
  override: BuildOverride | undefined,
): boolean {
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return hasBuilderLabel(labels);
}

/**
 * Agent-side gate for `buildImage`/`pruneImages`: the local explicit override
 * wins; otherwise the controller's `builderCapable` assertion (it read the
 * node's builder role label at dispatch) decides. Absent assertion ⇒ refuse —
 * an older controller that doesn't know about the role keeps the old
 * default-off behaviour.
 */
export function buildGateAllows(override: BuildOverride | undefined, builderCapable: boolean | undefined): boolean {
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return builderCapable === true;
}

/** Operator-facing "how do I turn builds on" hint, shared by controller + agent errors. */
export const BUILDER_ENABLE_HINT =
  "turn on the 'Builder' role for a node (Nodes → pick a node → Controls → Builder), or set SWARMY_ALLOW_BUILD=true in that node's /etc/swarmy/agent.env";

// ── Terminal capabilities: container exec + host shell ──────────────────────
//
// Same shape as the builder role: a Docker node label the dashboard toggles
// (read live by the controller, asserted to the agent in the `termStart`
// payload as `nodeCapable`), plus an agent-local env override reported in the
// register facts. The real gate for WHO may open a terminal stays
// controller-side (ABAC `terminal.open` + org TerminalPolicy + audit +
// recording); these decide WHETHER a node accepts one at all.

/** Agent-local explicit override (`SWARMY_ALLOW_EXEC` / `SWARMY_ALLOW_NODE_SHELL`); same tri-state as builds. */
export type CapabilityOverride = BuildOverride;

/** Parse a raw tri-state capability env value; unset/empty/unknown → no override. */
export function parseCapabilityOverride(raw: string | null | undefined): CapabilityOverride | undefined {
  return parseBuildOverride(raw);
}

/**
 * Container exec is ON by default. `swarmy.node.exec=false` (dashboard toggle)
 * turns it off for one node; any other value (absent, '', 'true') is allowed.
 */
export const NODE_EXEC_LABEL = 'swarmy.node.exec';

/** Whether a node's live labels disable container exec (`swarmy.node.exec=false`). */
export function hasExecDisabledLabel(labels: Record<string, string> | undefined): boolean {
  return labels?.[NODE_EXEC_LABEL] === 'false';
}

/**
 * Controller-side: does this node accept container exec? The agent's explicit
 * `SWARMY_ALLOW_EXEC` override wins in both directions (as with builds);
 * otherwise exec is allowed unless the node label turns it off.
 */
export function isExecCapable(
  labels: Record<string, string> | undefined,
  override: CapabilityOverride | undefined,
): boolean {
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return !hasExecDisabledLabel(labels);
}

/**
 * Agent-side gate for container exec (`termStart` container / `execCommand`):
 * the local explicit override wins; otherwise the controller's `nodeCapable`
 * assertion decides, and an absent assertion (older controller) is ALLOWED —
 * exec is default-on.
 */
export function execGateAllows(override: CapabilityOverride | undefined, nodeCapable: boolean | undefined): boolean {
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return nodeCapable !== false;
}

/**
 * Host shell (`node shell` — root on the host) is OFF by default. Only
 * `swarmy.node.shell=true`, set by an admin from the node's controls panel
 * behind a confirmation, turns it on for that node.
 */
export const NODE_SHELL_LABEL = 'swarmy.node.shell';

/** Whether a node's live labels enable the host shell (`swarmy.node.shell=true`). */
export function hasShellLabel(labels: Record<string, string> | undefined): boolean {
  return labels?.[NODE_SHELL_LABEL] === 'true';
}

/**
 * Controller-side: does this node accept a host shell? Stricter than builds:
 * the label is REQUIRED, and `SWARMY_ALLOW_NODE_SHELL=false` on the box vetoes
 * it. `SWARMY_ALLOW_NODE_SHELL=true` does NOT force it on — a host shell is
 * never enabled without the audited dashboard toggle.
 */
export function isNodeShellCapable(
  labels: Record<string, string> | undefined,
  override: CapabilityOverride | undefined,
): boolean {
  if (override === 'deny') return false;
  return hasShellLabel(labels);
}

/**
 * Agent-side gate for `termStart` nodeShell: allowed only when the controller
 * asserted the node label (`nodeCapable === true`) AND the local env is not an
 * explicit `false`. Absent assertion ⇒ refuse (older controller keeps the old
 * default-off behaviour).
 */
export function nodeShellGateAllows(
  override: CapabilityOverride | undefined,
  nodeCapable: boolean | undefined,
): boolean {
  if (override === 'deny') return false;
  return nodeCapable === true;
}

/** Operator-facing hints, shared by controller + agent errors and the UI. */
export const EXEC_ENABLE_HINT =
  "turn 'Container exec' back on for the node (Nodes → pick a node → Controls → Container exec)";
export const EXEC_LOCAL_VETO_HINT =
  "blocked on the box by SWARMY_ALLOW_EXEC=false — remove it from that node's /etc/swarmy/agent.env and restart the agent";
export const NODE_SHELL_ENABLE_HINT =
  "an admin must turn on 'Host shell' for the node (Nodes → pick a node → Controls → Host shell)";
export const NODE_SHELL_LOCAL_VETO_HINT =
  "blocked on the box by SWARMY_ALLOW_NODE_SHELL=false — remove it from that node's /etc/swarmy/agent.env and restart the agent";

export const NODE_PROFILE_VALUES = ['default', 'edge', 'storage', 'database', 'private-mesh'] as const;
/** Install profile carried on a join token: the label bundle a node enrolls with. */
export type NodeProfile = (typeof NODE_PROFILE_VALUES)[number];

/** One-line descriptions for the token-mint profile picker. */
export const NODE_PROFILE_LABELS: Record<NodeProfile, { title: string; description: string }> = {
  default: { title: 'Default', description: 'A plain worker — assign roles later.' },
  edge: { title: 'Edge', description: 'Terminates public traffic (ingress role).' },
  storage: { title: 'Storage', description: 'Hosts object-storage members.' },
  database: { title: 'Database', description: 'Hosts managed databases.' },
  'private-mesh': { title: 'Private (mesh)', description: 'No public roles; joins the private mesh when enabled.' },
};

/**
 * The Docker node labels a profile bundles. Applied once at enrollment via the
 * normal label dispatch — after that the labels are ordinary Docker truth the
 * role switches edit; the profile is a starting point, never a sync source.
 */
export function profileToLabels(profile: NodeProfile | null | undefined): Record<string, string> {
  switch (profile) {
    case 'edge':
      return { 'swarmy.node.ingress': 'true' };
    case 'storage':
      return { [NODE_STORAGE_LABEL]: 'true' };
    case 'database':
      return { [NODE_DATABASE_LABEL]: 'true' };
    // private-mesh bundles NO labels — its meaning is the absence of public
    // roles plus mesh enrollment, which the register path triggers separately.
    case 'private-mesh':
    case 'default':
    default:
      return {};
  }
}

/** Parse a raw JoinToken.profile value; unknown/absent → null (default). */
export function parseNodeProfile(raw: string | null | undefined): NodeProfile | null {
  return raw != null && (NODE_PROFILE_VALUES as readonly string[]).includes(raw)
    ? (raw as NodeProfile)
    : null;
}

/** `violation` = declared intent is contradicted; `warning` = declared but unrealised. */
export type ExposureDriftLevel = 'violation' | 'warning';

/** Declared ≠ observed for one service: how bad, and why in plain words. */
export interface ExposureDriftView {
  level: ExposureDriftLevel;
  message: string;
}

/** An audit row plus the declared half of the comparison. */
export interface ExposureIntentRowView extends ExposureRowView {
  /** The `swarmy.expose` label value, or null when undeclared. */
  declared: ExposeMode | null;
  /** Non-null when declared ≠ observed. */
  drift: ExposureDriftView | null;
}

/** `ExposureOverview` whose rows carry declared intent + drift. */
export interface ExposureIntentOverview {
  rows: ExposureIntentRowView[];
  counts: ExposureOverview['counts'];
  auditedAt: string;
}
