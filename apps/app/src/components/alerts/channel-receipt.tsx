import * as React from 'react';
import { channelResultWords, type ChannelTestReceiptView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { Tech, TONE_TEXT } from '@/components/calm';
import { relTime } from '@/lib/format';

/** A test that just ran on this page (before the saved receipt refetches). */
export interface FreshTest {
  at: string;
  ok: boolean;
  detail: string;
}

/**
 * The channel's saved test receipt (board 55): when the last Send test went
 * out, whether it arrived, and what happened in plain words; the transport's
 * own answer sits underneath at Controls depth.
 */
export function ChannelReceipt({ saved, fresh }: { saved: ChannelTestReceiptView | null | undefined; fresh: FreshTest | null }): React.JSX.Element {
  const r = fresh ? { ...fresh, words: channelResultWords(fresh.ok, fresh.detail), by: null } : saved;
  if (!r) {
    return <p className="text-muted-foreground pl-11 text-[12.5px]">Never tested. Send a test to see it arrive.</p>;
  }
  const when = `${relTime(r.at)}${r.by ? ` by ${r.by}` : ''}`;
  return (
    <div role="status" className="flex flex-col gap-0.5 pl-11">
      <p className="text-[12.5px] leading-snug">
        <span className={cn('font-semibold', TONE_TEXT[r.ok ? 'ok' : 'bad'])}>{r.ok ? 'Arrived' : 'Didn’t arrive'}</span>
        <span className="text-muted-foreground">
          {' '}
          · last test {when}
          {r.ok ? '' : `. ${r.words}`}
        </span>
      </p>
      <Tech>{`${new Date(r.at).toLocaleString()} · ${r.detail}`}</Tech>
    </div>
  );
}
