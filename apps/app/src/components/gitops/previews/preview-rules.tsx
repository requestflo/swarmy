import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import type { PreviewRules } from '../gitops-types';
import { branchesWords, dataWords, duration, sleepWords } from './previews-model';

/**
 * Preview rules, read-only: production swarmy.yaml's `previews:` block as it
 * was last applied. Changing them is a commit to that file.
 */
export function PreviewRulesCard({ rules, configPath }: { rules: PreviewRules | null | undefined; configPath: string }): React.JSX.Element {
  const rows: Array<[string, string]> = rules
    ? [
        ['Branches', branchesWords(rules)],
        ['Keep for', rules.ttlSeconds ? `${duration(rules.ttlSeconds)} after the last push` : 'until the branch or PR goes'],
        ['While idle', sleepWords(rules)],
        ['New data', dataWords(rules)],
      ]
    : [];
  return (
    <Section title="Preview rules" hint="previews: in swarmy.yaml · read only">
      {rules ? (
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground text-[13px]">No production plan yet, so no rules to read. They come from the previews: block once main deploys.</p>
      )}
      <Tech>{`change them in ${configPath} — the next push to main applies them`}</Tech>
    </Section>
  );
}
