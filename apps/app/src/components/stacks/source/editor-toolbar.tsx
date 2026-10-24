import * as React from 'react';
import { GitBranchIcon } from 'lucide-react';
import type { ConfigIssue } from '@swarmy/app-config';
import { Button, cn } from '@swarmy/ui';
import { ToneChip } from './tone-chip';

export type FileTab = 'yaml' | 'compose';

/** "valid · schema v1" / "2 problems · line 14" / "valid · 1 warning". */
export function statusOf(issues: readonly ConfigIssue[]): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    const line = errors.find((i) => i.line)?.line;
    return { tone: 'bad', text: `${errors.length} problem${errors.length === 1 ? '' : 's'}${line ? ` · line ${line}` : ''}` };
  }
  const w = issues.length;
  return w ? { tone: 'warn', text: `valid · ${w} warning${w === 1 ? '' : 's'}` } : { tone: 'ok', text: 'valid · schema v1' };
}

/**
 * The editor's top row (board YamlEditor): the file switch, the commit it
 * was read at, live status, Validate and Export compose. swarmy can't write
 * to git, so where the board commits there's the honest instruction.
 */
export function EditorToolbar({
  tab,
  onTab,
  branch,
  sha,
  issues,
  dirty,
  onValidate,
  announce,
}: {
  tab: FileTab;
  onTab: (t: FileTab) => void;
  branch: string;
  sha: string;
  issues: readonly ConfigIssue[];
  dirty: boolean;
  onValidate: () => void;
  /** The last Validate result, read out to screen readers. */
  announce: string;
}): React.JSX.Element {
  const status = statusOf(issues);
  const seg = (t: FileTab, label: string): React.JSX.Element => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => onTab(t)}
      className={cn(
        'focus-visible:ring-ring/60 h-7 rounded-[8px] px-2.5 font-mono text-[11.5px] font-semibold outline-none focus-visible:ring-2 pointer-coarse:min-h-11',
        tab === t ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="File" className="border-border bg-background inline-flex gap-0.5 rounded-[10px] border p-0.5">
          {seg('yaml', 'swarmy.yaml')}
          {seg('compose', 'compose.yaml · generated')}
        </div>
        <ToneChip tone="idle" className="font-mono">
          <GitBranchIcon aria-hidden className="size-3" />
          {branch} · {sha.slice(0, 7)}
        </ToneChip>
        <ToneChip tone={status.tone}>{status.text}</ToneChip>
        {dirty ? <ToneChip tone="info">edited here · not in git</ToneChip> : null}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onValidate}>
            Validate
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onTab('compose')}>
            Export compose
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">Edit in your repo — swarmy applies it on push.</p>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
