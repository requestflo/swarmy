/**
 * What `gitConnections.startGithubManifest` hands back is the exact GitHub
 * App manifest the dashboard posts (JSON, built by `buildGithubManifest` in
 * packages/trpc/src/services/git-providers/github-app.ts). The wizard shows
 * it before you leave for GitHub: name, webhook, permissions, events.
 */
export interface ManifestPreview {
  name: string;
  webhook: string | null;
  /** `contents:read`, `checks:write`, … */
  permissions: string[];
  events: string[];
  public: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseManifest(json: string): ManifestPreview | null {
  let m: unknown;
  try {
    m = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(m) || typeof m.name !== 'string') return null;
  const hook = isRecord(m.hook_attributes) && typeof m.hook_attributes.url === 'string' ? m.hook_attributes.url : null;
  const perms = isRecord(m.default_permissions) ? m.default_permissions : {};
  return {
    name: m.name,
    webhook: hook,
    permissions: Object.entries(perms)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([k, v]) => `${k}:${v}`),
    events: Array.isArray(m.default_events) ? m.default_events.filter((e): e is string => typeof e === 'string') : [],
    public: m.public === true,
  };
}
