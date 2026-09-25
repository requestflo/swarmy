import * as React from 'react';
import { cn } from '@swarmy/ui';
import type { ConfigIssueView } from './gitops-types';

/** swarmy.yaml problems, each pinned to its line so you can jump straight to it. */
export function PlanIssues({
  issues,
  configPath,
}: {
  issues: ConfigIssueView[];
  configPath?: string;
}): React.JSX.Element | null {
  if (issues.length === 0) return null;
  const errors = issues.filter((i) => i.severity === 'error').length;
  return (
    <section className="border-status-offline/30 rounded-2xl border">
      <p className="px-5 pt-4 text-sm font-semibold">
        {errors > 0
          ? `${errors} problem${errors === 1 ? '' : 's'} in ${configPath ?? 'swarmy.yaml'} — nothing ran.`
          : `${issues.length} warning${issues.length === 1 ? '' : 's'} in ${configPath ?? 'swarmy.yaml'}.`}
      </p>
      <ul className="divide-border divide-y">
        {issues.map((i, n) => (
          <li key={`${i.code}-${n}`} className="flex gap-3 px-5 py-3 text-sm">
            <span
              className={cn(
                'mono-data w-14 shrink-0 text-xs',
                i.severity === 'error' ? 'text-tone-bad' : 'text-tone-warn',
              )}
            >
              {i.line ? `L${i.line}${i.col ? `:${i.col}` : ''}` : '—'}
            </span>
            <div className="min-w-0">
              <p>{i.message}</p>
              {i.path.length ? (
                <p className="text-muted-foreground mono-label truncate">{i.path.join('.')}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
