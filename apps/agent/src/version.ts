// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent version + build introspection.
 *
 * `VERSION` is the single repo-wide product version, read from this app's
 * package.json so it always reflects whatever the release pipeline stamped in
 * (scripts/set-version.ts). `COMMIT` is the git sha baked at image-build time via
 * the `SWARMY_COMMIT` env (falls back to "dev"). Surfaced by `swarmy-agent
 * --version` and reported to the controller on register.
 */
import pkg from '../package.json' with { type: 'json' };
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';

export const VERSION: string = pkg.version;
export const PROTOCOL_VERSION_NUMBER: number = PROTOCOL_VERSION;
export const COMMIT: string = process.env.SWARMY_COMMIT ?? 'dev';

export interface VersionInfo {
  version: string;
  protocolVersion: number;
  commit: string;
}

export function versionInfo(): VersionInfo {
  return { version: VERSION, protocolVersion: PROTOCOL_VERSION_NUMBER, commit: COMMIT };
}
