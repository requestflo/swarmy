import * as React from 'react';
import { cn } from '@swarmy/ui';

export type GitChipTone = 'ok' | 'mesh' | 'info' | 'warn' | 'idle';

const TONE: Record<GitChipTone, string> = {
  ok: 'bg-status-online/12 text-tone-ok',
  mesh: 'bg-tone-mesh/12 text-tone-mesh',
  info: 'bg-status-progress/12 text-tone-info',
  warn: 'bg-status-warning/15 text-tone-warn',
  idle: 'bg-muted text-muted-foreground',
};

/** A small tag on the git wizard: "connected · northwind", "Dockerfile", "contents:read". */
export function GitChip({
  tone = 'idle',
  mono,
  children,
  className,
}: {
  tone?: GitChipTone;
  mono?: boolean;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        mono && 'font-mono font-medium',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
