import { curl, toYaml, withHeader, type CodeTab } from '@/components/calm';
import type { GitApp } from '../gitops-types';
import { rulesYaml } from './previews-model';

/** The rules as swarmy.yaml, a preview from the CLI, and the same call over REST. */
export function previewsCode(app: GitApp, branch: string): CodeTab[] {
  const b = branch || 'feature/my-branch';
  const name = app.appName ?? app.fullName ?? app.repoId;
  return [
    ...(app.previewRules
      ? [{ label: 'swarmy.yaml', code: withHeader(`${app.configPath} — the rules every preview follows`, toYaml(rulesYaml(app.previewRules) as Parameters<typeof toYaml>[0])) }]
      : []),
    { label: 'CLI', code: [`# push the branch first — swarmy builds from git`, `swarmy deploy --preview --branch ${b} --app ${name}`].join('\n') },
    { label: 'REST', code: curl('POST', `/apps/${app.repoId}/previews`, { branch: b }) },
  ];
}
