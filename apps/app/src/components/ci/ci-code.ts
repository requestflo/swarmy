import { curl, toYaml, type CodeTab } from '@/components/calm';

/** Code depth: the repo's swarmy.yaml build keys, and the git/registry endpoints of the public API. */
export function ciCode(registry: unknown): CodeTab[] {
  return [
    {
      label: 'REST',
      code: [curl('GET', '/git/connections'), curl('GET', '/git/repos'), curl('GET', '/registry-credentials')].join('\n\n'),
    },
    { label: 'CLI', code: 'swarmy link        # tie this folder to its app\nswarmy check       # will this repo build and run?\nswarmy deploy      # build and roll out the current branch' },
    { label: 'registry', code: toYaml({ registry: registry as never }) },
  ];
}
