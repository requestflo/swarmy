import { curl, withHeader, type CodeTab } from '@/components/calm';

/**
 * The Source tab at Code depth: the same check from a terminal (the CLI's
 * local `check` runs this parser), the push that applies it, and the plans
 * it produced over REST. Real commands and paths only.
 */
export function sourceCodeTabs(repoId: string, path: string, branch: string): CodeTab[] {
  return [
    {
      label: 'CLI',
      code: withHeader(
        'in a checkout of the repo',
        [`$ swarmy check .${path === 'swarmy.yaml' ? '' : ` --config ${path}`}`, `$ git push origin ${branch}`, '$ swarmy status'].join('\n'),
      ),
    },
    { label: 'REST', code: withHeader('what each push planned and applied', curl('GET', `/apps/${repoId}/plans`)) },
  ];
}
