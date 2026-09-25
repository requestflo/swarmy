import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth } from './depth';

/**
 * A mono technical line (digests, IPs, copies, lag). It appears from Controls
 * up, so Summary never shows glossary words.
 */
export function Tech({
  children,
  className,
  always,
}: {
  children: React.ReactNode;
  className?: string;
  /** Show at every depth (rare: a value the sentence itself refers to). */
  always?: boolean;
}): React.JSX.Element {
  const line = (
    <span className={cn('text-muted-foreground font-mono text-[11.5px] leading-relaxed break-words', className)}>
      {children}
    </span>
  );
  return always ? line : <Depth at="controls">{line}</Depth>;
}
