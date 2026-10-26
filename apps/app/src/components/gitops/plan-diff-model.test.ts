import { describe, expect, test } from 'bun:test';
import { baseWords, planDiffTabs, type PlanDiff } from './plan-diff-model';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const view = (o: Partial<PlanDiff> = {}): PlanDiff => ({
  sha: B,
  environment: 'production',
  path: 'swarmy.yaml',
  base: { sha: A, environment: 'production', appliedAt: '2026-10-26T08:00:00Z', relation: 'live' },
  file: { before: 'app: shop\nservices:\n  web: { replicas: 2 }\n', after: 'app: shop\nservices:\n  web: { replicas: 3 }\n' },
  fileError: null,
  spec: { before: 'replicas: 2\n', after: 'replicas: 3\n' },
  ...o,
});

describe('planDiffTabs (board 26 YAML diff)', () => {
  test('the file and the spec as unified diffs against the live release', () => {
    const [file, spec] = planDiffTabs(view());
    expect(file).toEqual({
      label: 'swarmy.yaml',
      code: [
        '--- swarmy.yaml @ aaaaaaa (live)',
        '+++ swarmy.yaml @ bbbbbbb (this plan)',
        '@@ -1,3 +1,3 @@',
        ' app: shop',
        ' services:',
        '-  web: { replicas: 2 }',
        '+  web: { replicas: 3 }',
      ].join('\n'),
    });
    expect(spec!.label).toBe('Desired spec');
    expect(spec!.code).toContain('-replicas: 2\n+replicas: 3');
  });

  test('a commit that leaves the file alone says so, byte for byte', () => {
    const same = 'app: shop\n';
    const [file] = planDiffTabs(view({ file: { before: same, after: same } }));
    expect(file!.code).toBe('# swarmy.yaml is the same at aaaaaaa and bbbbbbb, byte for byte.\n# The change is in the code (a new build), not in the file.');
  });

  test('a first deploy diffs from nothing; git unreadable keeps the spec tab', () => {
    const [first] = planDiffTabs(view({ base: null, file: { before: null, after: 'app: shop\n' } }));
    expect(first!.code).toContain('--- swarmy.yaml (nothing applied yet)\n+++ swarmy.yaml @ bbbbbbb (this plan)\n@@ -0,0 +1,1 @@\n+app: shop');
    const tabs = planDiffTabs(view({ file: null, fileError: "couldn't read swarmy.yaml from git: no Builder is online" }));
    expect(tabs[0]!.code.split('\n')[0]).toBe("# couldn't read swarmy.yaml from git: no Builder is online");
    expect(tabs).toHaveLength(2);
  });

  test('a preview has no spec tab; a monorepo path labels by file name', () => {
    const tabs = planDiffTabs(view({ environment: 'preview', spec: null, path: 'services/payments/swarmy.yaml' }));
    expect(tabs.map((t) => t.label)).toEqual(['swarmy.yaml']);
    expect(tabs[0]!.code.split('\n')[0]).toBe('--- services/payments/swarmy.yaml @ aaaaaaa (live)');
  });

  test('base words', () => {
    expect(baseWords(view())).toBe('what production runs now (aaaaaaa)');
    expect(baseWords(view({ base: { sha: A, environment: 'production', appliedAt: null, relation: 'before' } }))).toBe('the release before it (aaaaaaa)');
    expect(baseWords(view({ base: null, environment: 'staging' }))).toBe('nothing applied yet in staging');
  });
});
