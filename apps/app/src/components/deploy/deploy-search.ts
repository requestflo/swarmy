import { parseGitResultSearch, type GitResultSearch } from '@/components/ci/git-result-banner';

/**
 * `/deploy` search: `?source=git` opens the git wizard (the CLI page links
 * here), and the provider round trip comes back with the `?git=…` result plus
 * `created=<host>` when it registered a GitHub App.
 */
export interface DeploySearch extends GitResultSearch {
  source?: 'git';
  created?: string;
}

export function parseDeploySearch(search: Record<string, unknown>): DeploySearch {
  const out: DeploySearch = parseGitResultSearch(search);
  if (search.source === 'git') out.source = 'git';
  if (typeof search.created === 'string' && /^https?:\/\/[\w.:-]{1,200}$/.test(search.created)) out.created = search.created;
  return out;
}
