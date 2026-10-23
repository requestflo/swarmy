import { matchCredential, splitImageRef } from '@swarmy/core';

/**
 * "Which credentials will this image use?" — the same order the hub's pull-auth
 * decorator follows: the in-swarm registry first (swarmy signs in itself), then
 * the saved login with the LONGEST matching prefix (`matchCredential`, shared
 * with the controller), else none (a public pull).
 */
export type ImageResolution<C extends { prefix: string }> =
  | { kind: 'builtin'; ref: string; host: string }
  | { kind: 'login'; ref: string; cred: C; beats: C | null }
  | { kind: 'none'; ref: string; host: string };

export function resolveImageLogin<C extends { prefix: string }>(
  image: string,
  creds: readonly C[],
  builtinHost: string | null,
): ImageResolution<C> | null {
  if (!image.trim()) return null;
  const { host, repo, reference } = splitImageRef(image);
  // A digest (`sha256:…`) is written `@`, a tag `:` — as `docker pull` would.
  const ref = `${host}/${repo}${reference.includes(':') ? '@' : ':'}${reference}`;
  if (builtinHost && host === builtinHost.toLowerCase()) return { kind: 'builtin', ref, host };
  const cred = matchCredential(image, creds);
  if (!cred) return { kind: 'none', ref, host };
  // The runner-up: the next-longest prefix that also covers this image.
  const beats = matchCredential(image, creds.filter((c) => c !== cred));
  return { kind: 'login', ref, cred, beats };
}

/** The plain sentence for a resolution (board 54 copy). */
export function resolutionSentence<C extends { prefix: string; username: string }>(r: ImageResolution<C>): string {
  if (r.kind === 'builtin') {
    return `${r.host} is your in-swarm registry — no credentials needed, pulled over the private network.`;
  }
  if (r.kind === 'none') return `No saved login matches ${r.host} — the image has to be public to pull.`;
  const uses = `Uses ${r.cred.prefix} (${r.cred.username})`;
  if (r.beats) return `${uses} — it beats ${r.beats.prefix} because the longer prefix wins.`;
  const hub = r.cred.prefix === 'docker.io' ? ' Authenticated pulls dodge Docker Hub’s anonymous rate limit.' : '';
  return `${uses} — the only prefix that matches.${hub}`;
}
