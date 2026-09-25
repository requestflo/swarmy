import * as React from 'react';
import type { StatusTone } from '@swarmy/ui';
import { StatusWord, toneFromStatus } from '@/components/calm';

/** `StatusBadge`'s props, drawn as the calm status word (text-safe tone colours). */
export function CalmBadge({ tone, label, className }: { tone: StatusTone; label: string; className?: string }): React.JSX.Element {
  return <StatusWord tone={toneFromStatus(tone)} word={label} className={className} />;
}
