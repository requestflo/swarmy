import type { GitConnection } from './git-types';

/**
 * The four ways in on the git wizard (board 23): GitHub, GitLab, a
 * self-hosted server (GitHub Enterprise, GitLab self-managed, Gitea), or any
 * git URL. Each card is backed by the org's connections of that shape.
 */
export type GitProviderId = 'github' | 'gitlab' | 'self' | 'url';

export const GITHUB_WEB = 'https://github.com';
export const GITLAB_WEB = 'https://gitlab.com';

export interface GitProviderMeta {
  id: GitProviderId;
  name: string;
  /** Mono line under the name. */
  host: string;
  /** What connecting means, in one line. */
  what: string;
}

export const GIT_PROVIDERS: GitProviderMeta[] = [
  { id: 'github', name: 'GitHub', host: 'github.com', what: 'Install the swarmy app on your org. Pick repos, not a token.' },
  { id: 'gitlab', name: 'GitLab', host: 'gitlab.com', what: 'Sign in or paste a token, then pick a project. Webhooks set for you.' },
  { id: 'self', name: 'Self-hosted', host: 'GitHub Enterprise · GitLab · Gitea', what: 'Your own server. We create a private GitHub App in one click.' },
  { id: 'url', name: 'Any git URL', host: 'HTTPS or SSH', what: 'A public repo, or SSH with a deploy key we make for you.' },
];

const bare = (u: string): string => u.replace(/\/+$/, '');

/** `https://github.northwind.dev/` → `github.northwind.dev`. */
export function hostOf(url: string): string {
  return bare(url).replace(/^https?:\/\//, '');
}

/** Which card a connection belongs to. */
export function providerOf(c: Pick<GitConnection, 'kind' | 'baseUrl'>): GitProviderId {
  if (c.kind === 'generic') return 'url';
  if (c.kind === 'github' && bare(c.baseUrl) === GITHUB_WEB) return 'github';
  if (c.kind === 'gitlab' && bare(c.baseUrl) === GITLAB_WEB) return 'gitlab';
  return 'self';
}

/** The usable (active) connections behind one card. */
export function connectionsFor(p: GitProviderId, conns: GitConnection[]): GitConnection[] {
  return conns.filter((c) => c.status === 'active' && providerOf(c) === p);
}

/** How an account reads in the picker: "northwind", or "dana.ops · gitlab.corp.example" off the default host. */
export function accountLabel(c: GitConnection): string {
  const who = c.account ?? c.displayName;
  return providerOf(c) === 'self' || providerOf(c) === 'url' ? `${who} · ${hostOf(c.baseUrl)}` : who;
}

export interface ProviderChip {
  label: string;
  tone: 'ok' | 'mesh' | 'idle';
}

/** The chip on a card: "connected · northwind", "not connected", "one-click app". */
export function providerChip(p: GitProviderId, conns: GitConnection[]): ProviderChip {
  const on = connectionsFor(p, conns);
  if (on.length === 1) return { label: `connected · ${on[0]!.account ?? hostOf(on[0]!.baseUrl)}`, tone: 'ok' };
  if (on.length > 1) return { label: `connected · ${on.length} accounts`, tone: 'ok' };
  if (p === 'self') return { label: 'one-click app', tone: 'mesh' };
  if (p === 'url') return { label: 'no sign-in needed', tone: 'idle' };
  return { label: 'not connected', tone: 'idle' };
}

/** Where the wizard opens: the connection just made, else the first connected card, else GitHub. */
export function initialProvider(conns: GitConnection[], connectionId?: string): GitProviderId {
  const just = conns.find((c) => c.id === connectionId);
  if (just) return providerOf(just);
  const first = (['github', 'gitlab', 'self'] as const).find((p) => connectionsFor(p, conns).length > 0);
  return first ?? 'github';
}
