import * as React from 'react';
import { DatabaseIcon } from 'lucide-react';
import { previewDataNote, previewLabel, type AppPreview } from './gitops-types';

/** A standing note for every preview that carries a copy of real data — never hidden behind a click. */
export function AppPreviewDataNotes({
  previews,
}: {
  previews: AppPreview[];
}): React.JSX.Element | null {
  const withData = previews.filter((p) => p.data);
  if (withData.length === 0) return null;
  return (
    <ul className="space-y-1">
      {withData.map((p) => (
        <li key={p.stack} className="text-muted-foreground flex items-start gap-2 text-xs">
          <DatabaseIcon className="text-status-progress mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="text-foreground font-medium">{previewLabel(p)}</span> ·{' '}
            {previewDataNote(p)}
          </span>
        </li>
      ))}
    </ul>
  );
}
