/**
 * The web page of one file in a git repo, from the clone URL swarmy tracks
 * (`https://…/org/repo.git` or `git@host:org/repo.git`). GitLab uses
 * `/-/blob/`; GitHub, Gitea and Forgejo use `/blob/`. Null when the URL
 * can't be turned into a web address.
 */
export function repoFileUrl(cloneUrl: string, branch: string, path: string): string | null {
  const url = cloneUrl.trim();
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(url);
  const base = ssh ? `https://${ssh[1]}/${ssh[2]}` : /^https?:\/\//.test(url) ? url.replace(/^(https?:\/\/)[^@/]+@/, '$1') : null;
  if (!base) return null;
  const repo = base.replace(/\.git$/, '').replace(/\/+$/, '');
  const blob = /gitlab/i.test(new URL(repo).host) ? '/-/blob/' : '/blob/';
  const file = path.replace(/^\.?\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${repo}${blob}${branch.split('/').map(encodeURIComponent).join('/')}/${file}`;
}
