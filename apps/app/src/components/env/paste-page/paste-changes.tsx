import * as React from 'react';
import { Label, Switch } from '@swarmy/ui';
import { Section } from '@/components/calm';
import type { EnvPasteState } from '../use-env-paste';
import { EnvChangeGroups } from './env-change-groups';
import { changeSummary } from './paste-model';

/** "What changes": the summary line, merge vs Replace all, and the grouped rows. */
export function PasteChanges({ st, short, existing }: { st: EnvPasteState; short: string; existing: ReadonlySet<string> }): React.JSX.Element {
  const replace = st.mode === 'replace';
  const removed = st.diff.rows.filter((r) => r.kind === 'removed').length;
  return (
    <Section
      title="What changes"
      hint={st.text.trim() ? changeSummary(st.diff.rows, st.pasted, st.warnings.length, replace) : undefined}
      flush
      className="min-w-0"
      action={
        <span className="flex items-center gap-2">
          <Switch id="paste-replace" checked={replace} onCheckedChange={(v) => st.setMode(v ? 'replace' : 'merge')} />
          <Label htmlFor="paste-replace" className="text-[13px] font-semibold">
            Replace all
          </Label>
        </span>
      }
    >
      <p className="text-muted-foreground text-xs">
        {replace
          ? `Replace all: ${short} ends up with exactly this file (its secrets stay). ${removed === 1 ? '1 variable is' : `${removed} variables are`} removed.`
          : 'Merge: variables the paste doesn’t name stay as they are. Turn on Replace all to remove them.'}
      </p>
      <EnvChangeGroups rows={st.diff.rows} masked={st.masked} onToggle={st.toggleMask} existingSecrets={existing} />
    </Section>
  );
}
