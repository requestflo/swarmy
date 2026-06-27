/**
 * Translation warnings surfaced to the GUI when importing compose. Pure data —
 * no I/O. See plans/epic-stack-gui-builder.md "Round-trip fidelity".
 */

export type WarningLevel = 'info' | 'warn' | 'lossy';

export interface TranslationWarning {
  level: WarningLevel;
  /** Dotted path into the source service, e.g. `web.build` or `web.ports[0]`. */
  path: string;
  /** Stable machine code, e.g. `unsupported-key`, `lossy-normalization`. */
  code: string;
  message: string;
}

/**
 * Compose service-level keys swarmy is aware of but that Swarm ignores. They are
 * preserved into `model.unsupported` and surfaced as `warn`/`info`, never sent
 * to the agent.
 */
export const SWARM_INCOMPATIBLE_KEYS = new Set([
  'build',
  'volumes_from',
  'network_mode',
  'profiles',
  'extends',
  'container_name',
  'links',
  'privileged',
  'devices',
]);
