import * as React from 'react';
import { cn } from '@swarmy/ui';
import { GitChip } from './git-chip';
import { yamlRows } from './git-scan-model';
import type { Draft } from './git-scan-types';

/**
 * The generated swarmy.yaml, read-only, with line numbers — and the
 * controller parser's verdict: "valid · v1", or each problem at its line.
 */
export function GitScanYaml({ path, draft, stale }: { path: string; draft: Draft; stale: boolean }): React.JSX.Element {
  const rows = React.useMemo(() => yamlRows(draft.yaml), [draft.yaml]);
  const errors = draft.issues.filter((i) => i.severity === 'error');
  const bad = new Set(draft.issues.map((i) => i.line).filter(Boolean));
  return (
    <section aria-label="Generated swarmy.yaml" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="calm-eyebrow truncate">{path}</span>
        <GitChip tone={draft.valid ? 'ok' : 'warn'} className="ml-auto">
          {draft.valid ? 'valid · v1' : `${errors.length} problem${errors.length === 1 ? '' : 's'}`}
        </GitChip>
      </div>
      <pre
        tabIndex={0}
        aria-label={`${path}, generated`}
        className={cn('calm-code max-h-[460px] overflow-auto py-3 transition-opacity', stale && 'opacity-60')}
      >
        {rows.map((r) => (
          <div key={r.no} className={cn('flex pr-4 whitespace-pre', bad.has(r.no) && 'bg-status-warning/15')}>
            <span aria-hidden className="w-10 shrink-0 pr-3 text-right opacity-45 select-none">
              {r.no}
            </span>
            <span>
              {r.indent}
              {r.key ? <span className="font-semibold">{r.key}</span> : null}
              {r.sep}
              {r.value}
              {r.comment ? <span className="opacity-60">{r.value || r.key ? ' ' : ''}{r.comment}</span> : null}
            </span>
          </div>
        ))}
      </pre>
      {draft.issues.length ? (
        <ul className="flex flex-col gap-0.5 text-[12.5px]">
          {draft.issues.map((i) => (
            <li key={`${i.line ?? 0}:${i.message}`} className={i.severity === 'error' ? 'text-tone-warn' : 'text-muted-foreground'}>
              <span className="font-mono">{i.line ? `line ${i.line}` : path}</span> · {i.message}
            </li>
          ))}
        </ul>
      ) : null}
      {draft.notes.map((n) => (
        <p key={n} className="text-muted-foreground text-[12.5px]">
          {n}
        </p>
      ))}
    </section>
  );
}
