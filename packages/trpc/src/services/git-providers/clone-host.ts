/**
 * Clone-URL ↔ connection host binding (security review M7). A connection's
 * credential (GitHub installation token, GitLab / Gitea OAuth token, PAT) is
 * only ever sent to the git host the connection was made for: a repo or
 * wizard URL naming any other host is refused before a token is attached,
 * so a crafted `cloneUrl` can't carry the org's token to an attacker's server.
 *
 * Pure — the services call it at link, inspect and credential-resolution time.
 */

export interface RemoteHost {
  scheme: 'http' | 'https' | 'ssh';
  /** Lowercased hostname, no port. */
  hostname: string;
  /** The explicit port, or '' for the scheme's default. */
  port: string;
}

/** `user@host:path` (scp-style ssh) — no scheme, a colon before the first slash. */
const SCP_RE = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):(?!\/\/)/;

/** Parse a git remote (`https://h[:p]/…`, `ssh://u@h[:p]/…`, `u@h:path`); null when it isn't one. */
export function remoteHost(url: string): RemoteHost | null {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    if (!URL.canParse(u)) return null;
    const p = new URL(u);
    const scheme = p.protocol.slice(0, -1).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh') return null;
    if (!p.hostname) return null;
    return { scheme, hostname: p.hostname.toLowerCase(), port: p.port };
  }
  const m = SCP_RE.exec(u);
  return m?.[1] ? { scheme: 'ssh', hostname: m[1].toLowerCase(), port: '' } : null;
}

/**
 * May a credential made for `baseUrl` be used against `remote`? The same
 * hostname always. Same scheme → also the same port. Never a downgrade from
 * an https connection to a plain-http remote (the token would cross the
 * network in clear); an http connection's host over https is fine. ssh
 * remotes only need the hostname — the ssh port is not the web port, and
 * tokens never ride ssh anyway.
 */
export function remoteMatchesConnection(remote: string, baseUrl: string): boolean {
  const r = remoteHost(remote);
  const b = remoteHost(baseUrl);
  if (!r || !b || b.scheme === 'ssh') return false;
  if (r.hostname !== b.hostname) return false;
  if (r.scheme === 'ssh') return true;
  if (r.scheme !== b.scheme) return r.scheme === 'https'; // upgrade ok, downgrade refused
  return r.port === b.port;
}
