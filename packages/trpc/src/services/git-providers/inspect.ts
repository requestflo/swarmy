/**
 * git.inspect — read a commit without building it: the swarmy.yaml text (and
 * any other requested files), the repo's notable file names (for "we found a
 * Dockerfile / compose / swarmy.yaml in services/orders"), and the paths
 * changed since a base commit (monorepo build skipping).
 *
 * Runs as a `container.runOnce` on a Builder node, in the builder image the
 * node already has (it ships git): the controller never clones, and every git
 * host — GitHub, GitLab, Gitea, a bare SSH remote — takes the same path. A
 * partial, depth-1 fetch (`--filter=blob:none`) keeps it to a few KB for most
 * repos. Secrets travel as container env (never argv, never disk beyond the
 * container's own $HOME, removed with it).
 *
 * This file is PURE: the program renderer and the output parser are
 * golden-tested; `git-connections.service.ts` dispatches.
 */

export const INSPECT_IMAGE = 'moby/buildkit:rootless';
export const INSPECT_TIMEOUT_MS = 90_000;
/** Per-file cap (raw bytes). runOnce keeps a 64 KB output tail, so stay well under. */
export const INSPECT_MAX_FILE_BYTES = 32 * 1024;
export const INSPECT_MAX_CHANGED = 300;
export const INSPECT_MAX_TREE = 120;

/** File names worth knowing about when a repo is connected. */
export const NOTABLE_FILE_RE =
  '(^|/)(swarmy\\.ya?ml|Dockerfile|docker-compose\\.ya?ml|compose\\.ya?ml|package\\.json|railpack\\.json|go\\.mod|requirements\\.txt|Gemfile|Cargo\\.toml)$';

/** A 40/64-hex sha or a conservative ref name (branch/tag) — anything else is refused before it reaches a shell. */
const REF_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;
const PATH_RE = /^[A-Za-z0-9._/@+-][A-Za-z0-9._/@+ -]{0,299}$/;

export interface InspectRequest {
  url: string;
  /** Commit sha (preferred) or branch name. */
  ref: string;
  /** Diff base (the last applied sha / the PR merge base). */
  baseSha?: string;
  /** Files to return (repo-relative). */
  paths: string[];
  /** HTTPS token; username defaults per provider (`x-access-token`, `oauth2`). */
  token?: string;
  tokenUser?: string;
  /** OpenSSH private key for ssh:// / scp-style URLs. */
  sshKey?: string;
}

export interface InspectResult {
  /** The resolved commit sha. */
  sha: string;
  files: Record<string, string | null>;
  tree: string[];
  /** `undefined` = unknown (no base, base unreachable, or truncated) → build everything. */
  changedPaths?: string[];
}

export function validateInspectRequest(r: InspectRequest): string | null {
  if (!REF_RE.test(r.ref) || r.ref.includes('..')) return `invalid ref "${r.ref}"`;
  if (r.baseSha !== undefined && !/^[0-9a-f]{40,64}$/.test(r.baseSha)) return 'invalid base sha';
  for (const p of r.paths) {
    if (!PATH_RE.test(p) || p.split('/').includes('..') || p.startsWith('/'))
      return `invalid path "${p}"`;
  }
  return null;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell program (env: GIT_URL, GIT_TOKEN?, GIT_USER?, SWARMY_SSH_KEY?). */
export function renderInspectProgram(r: InspectRequest): string {
  const err = validateInspectRequest(r);
  if (err) throw new Error(err);
  const lines = [
    'set -e',
    'W="$HOME/inspect"; rm -rf "$W"; mkdir -p "$W"; cd "$W"',
    'git init -q . && git remote add origin "$GIT_URL"',
    'if [ -n "$SWARMY_SSH_KEY" ]; then',
    '  mkdir -p "$HOME/.ssh" && printf \'%s\\n\' "$SWARMY_SSH_KEY" > "$HOME/.ssh/id" && chmod 600 "$HOME/.ssh/id"',
    '  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts"',
    'fi',
    'if [ -n "$GIT_TOKEN" ]; then',
    '  B=$(printf \'%s:%s\' "${GIT_USER:-x-access-token}" "$GIT_TOKEN" | base64 | tr -d \'\\n\')',
    '  git config http.extraHeader "Authorization: Basic $B"',
    'fi',
    'echo SWARMY_BEGIN',
    `git fetch -q --filter=blob:none --depth=1 origin ${shq(r.ref)}`,
    'H=$(git rev-parse FETCH_HEAD)',
    'echo "SWARMY_HEAD $H"',
  ];
  if (r.baseSha) {
    lines.push(
      `if git fetch -q --filter=blob:none --depth=1 origin ${shq(r.baseSha)} 2>/dev/null; then`,
      `  C=$(git diff --name-only ${shq(r.baseSha)} "$H" | wc -l)`,
      `  if [ "$C" -gt ${INSPECT_MAX_CHANGED} ]; then echo SWARMY_CHANGED_UNKNOWN; else git diff --name-only ${shq(r.baseSha)} "$H" | sed 's/^/SWARMY_CHANGED\t/'; echo SWARMY_CHANGED_END; fi`,
      'else echo SWARMY_CHANGED_UNKNOWN; fi',
    );
  }
  lines.push(
    `git ls-tree -r --name-only "$H" | grep -E '${NOTABLE_FILE_RE}' | head -n ${INSPECT_MAX_TREE} | sed 's/^/SWARMY_TREE\t/' || true`,
  );
  for (const p of r.paths) {
    lines.push(
      `if git cat-file -e "$H":${shq(p)} 2>/dev/null; then`,
      `  S=$(git cat-file -s "$H":${shq(p)})`,
      `  if [ "$S" -gt ${INSPECT_MAX_FILE_BYTES} ]; then printf 'SWARMY_BIGFILE\\t%s\\n' ${shq(p)};`,
      `  else printf 'SWARMY_FILE\\t%s\\t%s\\n' ${shq(p)} "$(git cat-file blob "$H":${shq(p)} | base64 | tr -d '\\n')"; fi`,
      `else printf 'SWARMY_NOFILE\\t%s\\n' ${shq(p)}; fi`,
    );
  }
  lines.push('echo SWARMY_END');
  return lines.join('\n');
}

/** Container env for the program — the only place secrets appear. */
export function inspectEnv(r: InspectRequest): Record<string, string> {
  return {
    GIT_URL: r.url,
    ...(r.token ? { GIT_TOKEN: r.token, GIT_USER: r.tokenUser ?? 'x-access-token' } : {}),
    ...(r.sshKey ? { SWARMY_SSH_KEY: r.sshKey } : {}),
  };
}

export class InspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectError';
  }
}

/** Parse the program's marker lines. Throws `InspectError` on a truncated or failed run. */
export function parseInspectOutput(output: string, requestedPaths: string[]): InspectResult {
  const lines = output.split(/\r?\n/);
  if (!lines.includes('SWARMY_BEGIN') || !lines.includes('SWARMY_END')) {
    const tail = lines
      .filter((l) => l.trim() && !l.startsWith('SWARMY_'))
      .slice(-5)
      .join('\n');
    throw new InspectError(`could not read the commit${tail ? `: ${tail}` : ''}`);
  }
  let sha = '';
  const files: Record<string, string | null> = Object.fromEntries(
    requestedPaths.map((p) => [p, null]),
  );
  const tree: string[] = [];
  const changed: string[] = [];
  let changedKnown = false;
  for (const l of lines) {
    const [tag, a, b] = l.split('\t');
    if (l.startsWith('SWARMY_HEAD ')) sha = l.slice('SWARMY_HEAD '.length).trim();
    else if (tag === 'SWARMY_CHANGED' && a !== undefined) changed.push(a);
    else if (l === 'SWARMY_CHANGED_END') changedKnown = true;
    else if (tag === 'SWARMY_TREE' && a) tree.push(a);
    else if (tag === 'SWARMY_FILE' && a !== undefined)
      files[a] = Buffer.from(b ?? '', 'base64').toString('utf8');
    else if (tag === 'SWARMY_BIGFILE' && a)
      throw new InspectError(`${a} is larger than ${INSPECT_MAX_FILE_BYTES / 1024} KB`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new InspectError('could not resolve the commit');
  return { sha, files, tree, ...(changedKnown ? { changedPaths: changed } : {}) };
}

/** Directories holding a swarmy.yaml (monorepo app picker), from an inspect tree. */
export function configPathsIn(tree: string[]): string[] {
  return tree.filter((p) => /(^|\/)swarmy\.ya?ml$/.test(p)).sort();
}
