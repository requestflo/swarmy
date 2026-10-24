import * as React from 'react';
import { cn } from '@swarmy/ui';
import { TONE_TEXT, type Tone } from '@/components/calm';

const WASH: Record<Tone, string> = {
  ok: 'bg-status-online/15',
  warn: 'bg-status-warning/15',
  bad: 'bg-status-offline/15',
  info: 'bg-status-progress/15',
  mesh: 'bg-tone-mesh/15',
  idle: 'bg-muted',
};

/** A small washed status chip ("valid · schema v1", "+1 resource", "autodeploy on"). */
export function ToneChip({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold whitespace-nowrap', WASH[tone], tone === 'idle' ? 'text-muted-foreground' : TONE_TEXT[tone], className)}>
      {children}
    </span>
  );
}
