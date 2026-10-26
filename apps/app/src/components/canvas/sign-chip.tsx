import * as React from 'react';
import type { ImageSignatureView } from '@swarmy/core';
import { Popover, PopoverContent, PopoverTrigger, cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { signChipWords } from './sign-chip-model';

/**
 * Who signed the image this part runs (board AppCanvas's sign chip): signed /
 * signed · trusted key / unsigned / not checked. Hover shows the reason; a
 * tap opens it (touch has no hover) without selecting the part. Controls adds
 * the cosign fact.
 */
export function SignChip({ sign }: { sign: ImageSignatureView }): React.JSX.Element {
  const w = signChipWords(sign, Date.now());
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation();
  return (
    <Popover>
      <PopoverTrigger
        title={w.reason}
        aria-label={`Signature: ${w.label}. ${w.reason}`}
        onClick={stop}
        onPointerDown={stop}
        className={cn(
          'nodrag nopan inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] font-semibold',
          'border-border hover:border-foreground/25 relative',
          // A 44px-tall tap target on touch, without making the card taller.
          "pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 pointer-coarse:after:content-['']",
          TONE_TEXT[w.tone],
        )}
      >
        <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[w.tone])} />
        {w.label}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-1.5 p-3 text-[12.5px]" onClick={stop}>
        <p className={cn('font-semibold', TONE_TEXT[w.tone])}>{w.label}</p>
        <p className="text-foreground leading-snug">{w.reason}</p>
        <Tech className="break-all">{w.tech}</Tech>
      </PopoverContent>
    </Popover>
  );
}
