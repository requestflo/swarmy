import * as React from 'react';
import { FileCode2Icon } from 'lucide-react';
import { CopyButton } from '@swarmy/ui';

/** Mirrors `ComposeDraft` (packages/trpc/src/services/git-connections.service.ts). */
export interface ComposeDraft {
  from: string;
  yaml: string;
  notes: string[];
}

/**
 * The repo has a compose file but no swarmy.yaml: show the swarmy.yaml swarmy
 * converted from it, ready to copy into the repo and push. Data services
 * (postgres, redis, …) come across as managed resources.
 */
export function GitComposeDraft({ draft }: { draft: ComposeDraft }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <FileCode2Icon className="text-status-online size-4" />
        <span>
          Found <span className="mono-data">{draft.from}</span> — here’s a swarmy.yaml converted from it. Commit it at
          the repo root and push, then link.
        </span>
      </p>
      <div className="relative">
        <pre className="bg-accent/40 mono-data max-h-80 overflow-auto rounded-xl px-4 py-3 text-xs">{draft.yaml}</pre>
        <CopyButton value={draft.yaml} label="Copy" className="absolute top-2 right-2" />
      </div>
      {draft.notes.length > 0 ? (
        <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
          {draft.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
