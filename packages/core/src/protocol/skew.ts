import { compareVersions, parseSemver } from '../platform-manifest';
import { SUPPORTED_PROTOCOL_VERSIONS } from './constants';

/** Where an agent's build stands against this controller's. */
export type AgentSkewStatus = 'ok' | 'behind' | 'ahead' | 'incompatible';

export interface AgentSkew {
  status: AgentSkewStatus;
  /**
   * How many releases apart, counted in the most significant part that
   * differs (1.4.0 vs 1.2.0 → 2; 2.0.0 vs 1.9.3 → 1). Null when `ok`,
   * `incompatible`, or when a version isn't semver (dev builds).
   */
  versions: number | null;
}

type Semver = NonNullable<ReturnType<typeof parseSemver>>;

function distance(a: Semver, b: Semver): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return Math.abs(a[k] - b[k]);
  return 1; // only the prerelease differs (1.4.0-edge.3 vs 1.4.0)
}

/**
 * Agent ↔ controller version skew, from the agent's register facts. Pure.
 *
 * - `incompatible`: the agent speaks none of the controller's protocol
 *   versions — the two can't talk, whatever the release numbers say.
 * - `behind` / `ahead`: semver order of the agent's release against the
 *   controller's. When either isn't semver (an unreleased `dev` build), the
 *   newest protocol each side speaks decides instead.
 * - `ok`: same release (or, unversioned, the same newest protocol).
 */
export function agentSkew(
  controllerVersion: string,
  agentVersion: string,
  protocolVersions: readonly number[],
  supported: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): AgentSkew {
  if (!protocolVersions.some((v) => supported.includes(v))) return { status: 'incompatible', versions: null };
  const agent = parseSemver(agentVersion);
  const controller = parseSemver(controllerVersion);
  if (agent && controller) {
    const order = compareVersions(agentVersion, controllerVersion);
    if (order === 0) return { status: 'ok', versions: null };
    return { status: order < 0 ? 'behind' : 'ahead', versions: distance(agent, controller) };
  }
  const delta = Math.max(...protocolVersions) - Math.max(...supported);
  if (delta === 0) return { status: 'ok', versions: null };
  return { status: delta < 0 ? 'behind' : 'ahead', versions: null };
}
