import * as React from 'react';
import { Label, Switch } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { envLabel } from '@/components/gitops/plan-status';
import type { EnvPasteState } from '../use-env-paste';
import { EnvChangeGroups } from './env-change-groups';
import { changeSummary } from './paste-model';
import type { PastePlan } from './paste-target';

/**
 * "What changes": the summary line, merge vs Replace all, and the grouped
 * rows — one block per environment when the paste goes to every one.
 * Replace all works on one environment at a time.
 */
export function PasteChanges({
  st,
  plans,
  short,
  existing,
  shared,
}: {
  st: EnvPasteState;
  plans: PastePlan[];
  short: string;
  existing: ReadonlySet<string>;
  shared: boolean;
}): React.JSX.Element {
  const replace = st.mode === 'replace' && !shared;
  const removed = plans[0]?.rows.filter((r) => r.kind === 'removed').length ?? 0;
  const one = plans.length === 1 ? plans[0] : null;
  return (
    <Section
      title="What changes"
      hint={st.text.trim() && one ? changeSummary(one.rows, st.pasted, st.warnings.length, replace) : undefined}
      flush
      className="min-w-0"
      action={
        <span className="flex items-center gap-2">
          <Switch id="paste-replace" checked={replace} disabled={shared} onCheckedChange={(v) => st.setMode(v ? 'replace' : 'merge')} />
          <Label htmlFor="paste-replace" className="text-[13px] font-semibold">
            Replace all
          </Label>
        </span>
      }
    >
      <p className="text-muted-foreground text-xs">
        {shared
          ? 'Every environment: merged into each one. Replace all works on one environment at a time.'
          : replace
            ? `Replace all: ${short} ends up with exactly this file (its secrets and what swarmy.yaml declares stay). ${removed === 1 ? '1 variable is' : `${removed} variables are`} removed.`
            : 'Merge: variables the paste doesn’t name stay as they are. Turn on Replace all to remove them.'}
      </p>
      {one ? (
        <EnvChangeGroups rows={one.rows} masked={st.masked} onToggle={st.toggleMask} existingSecrets={existing} />
      ) : (
        plans.map((p) => (
          <div key={p.environment} className="border-border flex flex-col border-t pt-2 first:border-t-0">
            <h3 className="font-display pt-1 text-[14px] font-bold">
              {envLabel(p.environment)} <span className="text-muted-foreground font-mono text-[11px] font-normal">{p.stack}</span>
            </h3>
            <EnvChangeGroups rows={p.rows} masked={st.masked} onToggle={st.toggleMask} existingSecrets={existing} />
          </div>
        ))
      )}
    </Section>
  );
}
