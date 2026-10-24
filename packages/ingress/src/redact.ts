import type { RenderedConfig } from '@swarmy/core/protocol';
import { redactBcryptHashes } from './basic-auth';

export const SEALED = '<sealed in swarmy>';

/**
 * A rendered config fit to show people (`ingress.previewConfig`). The
 * dispatched render carries decrypted secrets for the agent — a tunnel's run
 * token in `connector.secrets[].value`, a locally-managed tunnel's credentials
 * file (written owner-only, mode 0600) — and route-password hashes. A preview
 * keeps every ref and path, never the secret itself.
 */
export function redactRenderedSecrets(rendered: RenderedConfig): RenderedConfig {
  const out: RenderedConfig = {
    ...rendered,
    files: rendered.files.map((f) => (isOwnerOnly(f.mode) ? { ...f, contents: SEALED } : f)),
    ...(rendered.connector
      ? {
          connector: {
            ...rendered.connector,
            secrets: rendered.connector.secrets.map((s) => (s.value === undefined ? s : { ...s, value: SEALED })),
          },
        }
      : {}),
  };
  return JSON.parse(redactBcryptHashes(JSON.stringify(out))) as RenderedConfig;
}

/** 0600-style files (no group/other bits) hold secrets; config files are 0644. */
function isOwnerOnly(mode: number | undefined): boolean {
  return mode !== undefined && (mode & 0o077) === 0;
}
