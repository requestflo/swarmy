import * as React from 'react';
import { cn } from '@swarmy/ui';

/** Token tints for letter avatars: never raw palette colours. */
const TINTS = [
  'bg-primary/12 text-primary',
  'bg-status-progress/15 text-tone-info',
  'bg-status-online/15 text-tone-ok',
  'bg-status-warning/15 text-tone-warn',
  'bg-tone-mesh/15 text-tone-mesh',
] as const;

function tintFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/** A template's avatar: its first letter on a tint picked from its id (no logos). */
export function LetterAvatar({
  id,
  name,
  size = 'md',
  className,
}: {
  id: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'font-display flex shrink-0 items-center justify-center font-bold',
        size === 'sm' && 'size-8 rounded-lg text-[14px]',
        size === 'md' && 'size-9 rounded-[10px] text-[15px]',
        size === 'lg' && 'size-11 rounded-xl text-[18px]',
        tintFor(id),
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
