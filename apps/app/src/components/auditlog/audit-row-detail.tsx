import * as React from 'react';
import { CopyButton } from '@swarmy/ui';
import type { AuditEntryView } from '@swarmy/core';

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 px-3 py-1.5 text-xs">
      <span className="mono-label text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="mono-data min-w-0 break-all">{value}</span>
    </div>
  );
}

/** Expanded row content: every column plus the full metadata JSON. */
export function AuditRowDetail({ entry }: { entry: AuditEntryView }): React.JSX.Element {
  const metaJson = JSON.stringify(entry.metadata, null, 2);
  return (
    <div className="border-border space-y-5 border-t px-4 py-5">
      <section>
        <h3 className="mono-label text-muted-foreground mb-2">Record</h3>
        <div className="bg-accent/20 divide-border divide-y rounded-lg">
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
        <pre className="bg-accent/20 mono-data max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg p-4 text-xs">
          {metaJson === '{}' ? '(no metadata)' : metaJson}
        </pre>
      </section>
    </div>
  );
}
