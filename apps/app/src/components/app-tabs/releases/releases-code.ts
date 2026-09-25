import type { ReleaseView } from '@swarmy/core';
import { curl, type CodeTab } from '@/components/calm';
import type { GitApp } from '@/components/gitops/gitops-types';
import { releaseLabel } from './release-label';

/** Deploy / promote / preview as the CLI and REST calls that do the same thing. */
export function releasesCode(stack: string, rows: ReleaseView[], app: GitApp | null): { tabs: CodeTab[]; readonly: boolean } {
  if (!app) {
    const history = rows.slice(0, 5).map((r) => ({
      version: releaseLabel(r),
      status: r.status,
      by: r.actor,
      at: r.createdAt,
      images: r.images.map((i) => i.image),
    }));
    return {
      readonly: true,
      tabs: [{ label: 'history', code: `# ${stack} — the last ${history.length} releases, as swarmy records them\n${JSON.stringify(history, null, 2)}` }],
    };
  }
  const name = app.appName ?? stack;
  const staging = app.environments.find((e) => e.environment !== 'production');
  const cli = [
    `# plan + apply the head of ${app.branch}`,
    `swarmy deploy --app ${name}`,
    '',
    '# a branch as its own preview',
    `swarmy deploy --app ${name} --preview --branch my-feature`,
    '',
    '# what is running where',
    `swarmy status --app ${name}`,
  ].join('\n');
  const rest = [
    curl('POST', `/apps/${app.repoId}/deploy`, {}),
    '',
    ...(staging ? [curl('POST', `/apps/${app.repoId}/promote`, { from: staging.environment }), ''] : []),
    curl('POST', `/apps/${app.repoId}/previews`, { branch: 'my-feature' }),
    '',
    curl('GET', `/apps/${app.repoId}/plans`),
  ].join('\n');
  return { readonly: false, tabs: [{ label: 'CLI', code: cli }, { label: 'REST', code: rest }] };
}
