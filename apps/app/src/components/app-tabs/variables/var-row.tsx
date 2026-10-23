import * as React from 'react';
import { ChevronDownIcon, LinkIcon, LockKeyholeIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, cn } from '@swarmy/ui';
import { TONE_TEXT, Tech } from '@/components/calm';
import { RotateSecretAlert } from '@/components/secretsmgr/rotate-secret-alert';
import { SecretRowExpand } from '@/components/secretsmgr/secret-row-expand';
import { scopeWords, sourceOf, techOf } from './var-source';
import type { TableRow } from './var-table-model';
import { VarValue } from './var-value';

interface VarRowProps {
  row: TableRow;
  stack: string;
  /** Services in the table's scope ("all" when a row reaches every one). */
  total: number;
  expanded: boolean;
  onToggle: () => void;
}

/** One variable or secret: name · value (Reveal) · Rotate · where it comes from and who reads it. */
export function VarRow({ row, stack, total, expanded, onToggle }: VarRowProps): React.JSX.Element {
  const id = React.useId();
  const src = sourceOf(row);
  const tech = techOf(row);
  const secret = row.kind === 'family' || row.kind === 'secretVar';
  return (
    <li className={cn('border-border border-b last:border-b-0', expanded && 'bg-foreground/[0.02]')}>
      <div className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2 lg:grid-cols-[15rem_minmax(0,1fr)_auto]">
        <span className="flex min-w-0 items-center gap-1.5">
          {secret ? <LockKeyholeIcon aria-label="secret" className="text-muted-foreground size-3 shrink-0" /> : null}
          {row.kind === 'binding' ? <LinkIcon aria-label="connection" className="text-tone-info size-3 shrink-0" /> : null}
          <span className="truncate font-mono text-[12.5px] font-semibold">{row.key}</span>
        </span>
        <span className="col-span-2 row-start-2 min-w-0 lg:col-span-1 lg:row-start-auto">
          <VarValue row={row} />
        </span>
        <span className="flex items-center justify-end gap-2 text-right text-xs">
          {row.family ? <RotateSecretAlert family={row.family} /> : null}
          <span className="hidden sm:inline">
            <span className={src.tone ? TONE_TEXT[src.tone] : 'text-muted-foreground'}>{src.word}</span>
            <span className="text-muted-foreground"> · {scopeWords(row, total)}</span>
          </span>
          {row.family ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-controls={id}
              aria-label={`${expanded ? 'Hide' : 'Show'} versions and wiring for ${row.key}`}
              className="text-muted-foreground hover:text-foreground grid size-7 place-items-center rounded-md pointer-coarse:size-11"
            >
              <ChevronDownIcon className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
            </button>
          ) : null}
        </span>
        <span className="text-muted-foreground col-span-full text-xs sm:hidden">
          <span className={src.tone ? TONE_TEXT[src.tone] : undefined}>{src.word}</span> · {scopeWords(row, total)}
        </span>
        {tech ? (
          <span className="col-span-full -mt-0.5">
            <Tech>{tech}</Tech>
          </span>
        ) : null}
      </div>
      {row.family ? (
        <Collapsible open={expanded}>
          <CollapsibleContent id={id}>
            <SecretRowExpand family={row.family} stack={stack} hideRotate />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </li>
  );
}
