import * as React from 'react';
import {
  CopyButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
} from '@swarmy/ui';
import type { AuditEntryView } from '@swarmy/core';
import { actionTone, humanizeAction } from './humanize';

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 px-3 py-1.5 text-xs">
      <span className="mono-label text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="mono-data min-w-0 break-all">{value}</span>
    </div>
  );
}

/** Detail drawer: every column of the row plus the full metadata JSON. */
export function AuditDetailSheet({
  entry,
  onOpenChange,
}: {
  entry: AuditEntryView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const metaJson = entry ? JSON.stringify(entry.metadata, null, 2) : '';
  return (
    <Sheet open={entry !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-border border-b p-6">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            Audit entry
            {entry ? <StatusBadge tone={actionTone(entry.action)} label={entry.action} className="mono-data" /> : null}
          </SheetTitle>
          <SheetDescription className="!mb-0 text-sm">
            {entry ? (
              <>
                <span className="text-foreground font-medium">{entry.actorLabel}</span>{' '}
                {humanizeAction(entry)} · {new Date(entry.ts).toLocaleString()}
              </>
            ) : (
              '…'
            )}
          </SheetDescription>
        </SheetHeader>

        {entry ? (
          <div className="space-y-6 p-6">
            <section>
              <h3 className="mono-label text-muted-foreground mb-2">Record</h3>
              <div className="card-pop divide-border divide-y">
                <Field label="id" value={entry.id} />
                <Field label="timestamp" value={entry.ts} />
                <Field label="actor type" value={entry.actorType} />
                <Field label="actor id" value={entry.actorId ?? '—'} />
                <Field label="actor" value={entry.actorLabel} />
                <Field label="action" value={entry.action} />
                <Field label="target type" value={entry.targetType ?? '—'} />
                <Field label="target id" value={entry.targetId ?? '—'} />
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="mono-label text-muted-foreground">Metadata</h3>
                <CopyButton value={metaJson} label="Copy JSON" />
              </div>
              <pre className="card-pop mono-data max-h-96 overflow-auto whitespace-pre-wrap break-all p-4 text-xs">
                {metaJson === '{}' ? '(no metadata)' : metaJson}
              </pre>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
