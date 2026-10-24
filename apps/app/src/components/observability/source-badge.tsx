import * as React from 'react';
import type { LogRowView } from '@swarmy/core';
import { cn } from '@swarmy/ui';

type Source = NonNullable<LogRowView['source']>;

const LABEL: Record<Source, string> = { stdout: 'stdout', otlp: 'OTLP' };
const TITLE: Record<Source, string> = {
  stdout: 'Printed by the app — read from its container output on the server',
  otlp: 'Sent by the app over OpenTelemetry',
};

/** Where a line came from, in words (the line's detail list). */
export function sourceWords(source: LogRowView['source']): string {
  return source === 'stdout' ? 'container output (stdout/stderr)' : 'sent by the app (OTLP)';
}

/** A small mono pill before the message: `stdout` (tailed) or `OTLP` (sent by the app). */
export function SourceBadge({ source }: { source: LogRowView['source'] }): React.JSX.Element {
  const s: Source = source ?? 'otlp';
  return (
    <span
      title={TITLE[s]}
      className={cn(
        'mr-2 inline-block rounded border px-1 align-[1px] font-mono text-[10.5px] leading-4 font-semibold',
        s === 'stdout' ? 'border-border text-muted-foreground' : 'border-tone-info/40 text-tone-info',
      )}
    >
      {LABEL[s]}
    </span>
  );
}
