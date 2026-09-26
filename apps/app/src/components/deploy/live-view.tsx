import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { SayHeader, TONE_DOT } from '@/components/calm';
import { clock } from './deploying-tracker';
import { LiveAddressCard } from './live-address-card';
import { LiveAlreadyOn } from './live-already-on';
import { LiveNextMoves } from './live-next-moves';
import type { DeployWatch } from './use-deploy-progress';

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Board "It's live": the eyebrow (NAME · DEPLOYED 10:41 · 1:02), the sentence,
 * the address card with the one coral Open ↗, what is already on, and the two
 * next moves. The duration shows only when this tab sent the deploy.
 */
export function LiveView({
  stack,
  watch,
  startedAt,
  liveAt,
  onLeave,
  banner,
}: {
  stack: string;
  watch: DeployWatch;
  startedAt: number | null;
  liveAt: number;
  onLeave: () => void;
  /** The one-time secrets banner, right under the sentence. */
  banner?: React.ReactNode;
}): React.JSX.Element {
  const took = startedAt ? ` · ${clock(Math.max(0, Math.round((liveAt - startedAt) / 1000)))}` : '';
  const short = (n: string): string => (n.startsWith(`${stack}_`) ? n.slice(stack.length + 1) : n);
  const main = watch.primary ? short(watch.primary.name) : stack;
  const rest = watch.steps.find((s) => s.key === 'data')?.state === 'done' ? ' + its data' : '';
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-7">
        <SayHeader
          eyebrow={
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className={`size-2 rounded-full ${TONE_DOT.ok}`} />
              {`${stack} · deployed ${hhmm(liveAt)}${took}`}
            </span>
          }
          title="It’s live."
          lede="Anyone can open it now. Share the address, or point your own domain at it later."
        />
        {banner}
        {watch.domain ? (
          <LiveAddressCard domain={watch.domain} />
        ) : (
          <p className="calm-card text-muted-foreground px-4 py-3.5 text-[13.5px]">
            It has no public address, so it only answers inside your servers.{' '}
            <Link to="/stacks/$name/network" params={{ name: stack }} search={{ add: '' }} onClick={onLeave} className="text-primary font-semibold">
              Add a domain
            </Link>
          </p>
        )}
        <LiveAlreadyOn stack={stack} domain={watch.domain} />
        <LiveNextMoves stack={stack} parts={`${main}${rest}`} onLeave={onLeave} />
      </div>
      {/*
        TODO(stats-strip): the right-hand slot of board "It's live" — a strip of
        first-response time, copies healthy and TLS grade over a preview of the
        site. Waiting on an owner decision (which numbers, and where each comes
        from honestly). Render nothing here until then.
      */}
    </div>
  );
}
