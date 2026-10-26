import * as React from 'react';
import { Button } from '@swarmy/ui';
import { Depth, Section, Tech } from '@/components/calm';
import type { GitApp, PreviewRules } from '../gitops-types';
import { PreviewRulesForm } from './preview-rules-form';
import { branchesWords, dataWords, duration, sleepWords } from './previews-model';

const HINT: Record<NonNullable<PreviewRules['source']>, string> = {
  file: 'previews: in swarmy.yaml',
  dashboard: 'saved in the dashboard',
  default: 'not set yet',
};

/**
 * Preview rules (board 68): who gets a preview, how long it's kept, when it
 * sleeps, what data it starts with. Read at Summary; changed at Controls —
 * as YAML to paste when swarmy.yaml sets them, else saved on the app.
 */
export function PreviewRulesCard({ app }: { app: GitApp }): React.JSX.Element {
  const rules = app.previewRules;
  const [editing, setEditing] = React.useState(false);
  const rows: Array<[string, string]> = rules
    ? [
        ['Branches', branchesWords(rules)],
        ['Keep for', rules.ttlSeconds ? `${duration(rules.ttlSeconds)} after the last push` : 'until the branch or PR goes'],
        ['While idle', sleepWords(rules)],
        ['New data', dataWords(rules)],
        ...(rules.size ? ([['Size', `at most ${rules.size} per service`]] as Array<[string, string]>) : []),
      ]
    : [];
  return (
    <Section title="Preview rules" hint={rules?.source ? HINT[rules.source] : 'previews: in swarmy.yaml'}>
      {editing ? (
        <PreviewRulesForm app={app} rules={rules} onDone={() => setEditing(false)} />
      ) : (
        <>
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
          <Depth at="controls">
            <Button variant="outline" size="sm" className="w-fit pointer-coarse:min-h-11" onClick={() => setEditing(true)}>
              Change the rules
            </Button>
          </Depth>
          <Tech>{rules?.source === 'file' ? `set in ${app.configPath} — the next push to ${app.branch} applies a change` : `kept on the app until ${app.configPath} has a previews: block`}</Tech>
        </>
      )}
    </Section>
  );
}
