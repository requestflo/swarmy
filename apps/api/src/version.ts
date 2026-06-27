// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Controller version + build introspection.
 *
 * `VERSION` is the single repo-wide product version (see
 * plans/epic-licensing-release-engineering.md — single-version semantic-release).
 * It is read from this app's package.json so the value is always whatever the
 * release pipeline stamped in (scripts/set-version.ts writes `nextRelease.version`
 * into every workspace package.json on release). `COMMIT` is the git sha baked at
 * image-build time via the `SWARMY_COMMIT` build arg/env (falls back to "dev").
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
