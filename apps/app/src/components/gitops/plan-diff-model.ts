/**
 * Pure: the plan drawer's YAML diff (board 26) as Code-view tabs — the
 * swarmy.yaml change and the rendered-spec change between the release that
 * is live and this plan, each a unified diff (`diff -u`, the same renderer
 * the edge Caddyfile view uses). Mirrors PlanDiffView in
 * packages/trpc/src/services/apps/plan-diff.ts.
 */
import type { CodeTab } from '@/components/calm';
import { edgeDiff as unifiedDiff } from '@/components/network/edge-diff';
import { envLabel, sha7 } from './plan-status';

export interface PlanDiff {
  sha: string;
  environment: string;
  path: string;
  base: { sha: string; environment: string; appliedAt: string | null; relation: 'live' | 'before' } | null;
  file: { before: string | null; after: string | null } | null;
  fileError: string | null;
  spec: { before: string | null; after: string | null } | null;
}

/** "production, live" · "the release before it" · "nothing yet". */
export function baseWords(v: PlanDiff): string {
  if (!v.base) return `nothing applied yet in ${envLabel(v.environment).toLowerCase()}`;
  const env = envLabel(v.base.environment).toLowerCase();
  return v.base.relation === 'live' ? `what ${env} runs now (${sha7(v.base.sha)})` : `the release before it (${sha7(v.base.sha)})`;
}

function diffText(o: { name: string; before: string | null; after: string | null; v: PlanDiff; same: string }): string {
  const { v } = o;
  const was = v.base ? `${o.name} @ ${sha7(v.base.sha)}${v.base.relation === 'live' ? ' (live)' : ''}` : `${o.name} (nothing applied yet)`;
  const now = `${o.name} @ ${sha7(v.sha)} (this plan)`;
  return unifiedDiff({ label: was, text: o.before ?? '' }, { label: now, text: o.after ?? '' }) ?? o.same;
}

export function planDiffTabs(v: PlanDiff): CodeTab[] {
  let file: string;
  if (!v.file) file = `# ${v.fileError ?? `couldn't read ${v.path}`}\n# The spec tab still shows what this plan changes.`;
  else if (v.file.after === null) file = `# ${v.path} isn't in commit ${sha7(v.sha)}.`;
  else
    file = diffText({
      name: v.path,
      before: v.file.before,
      after: v.file.after,
      v,
      same: `# ${v.path} is the same at ${v.base ? sha7(v.base.sha) : '—'} and ${sha7(v.sha)}, byte for byte.\n# The change is in the code (a new build), not in the file.`,
    });
  const tabs: CodeTab[] = [{ label: v.path.split('/').pop() ?? v.path, code: file }];
  if (v.spec) {
    tabs.push({
      label: 'Desired spec',
      code:
        v.spec.after === null
          ? `# This plan rendered no spec: ${v.path} didn't parse at ${sha7(v.sha)}.`
          : diffText({ name: 'desired spec', before: v.spec.before, after: v.spec.after, v, same: '# The rendered spec is the same: swarmy runs exactly what it runs now.' }),
    });
  }
  return tabs;
}
