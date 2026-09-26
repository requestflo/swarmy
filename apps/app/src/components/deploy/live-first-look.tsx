import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FirstLookView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

const day = (iso: string): string => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

function Stat({ value, label }: { value: string; label: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-0.5">
      <dt className="text-muted-foreground text-[12px]">{label}</dt>
      <dd className="font-mono text-[17px] font-semibold tracking-[-0.01em]">{value}</dd>
    </div>
  );
}

function stats(v: FirstLookView): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  if (v.response?.ok) out.push({ value: `${v.response.ms} ms`, label: 'first response' });
  if (v.copies.desired > 0) out.push({ value: `${v.copies.running} of ${v.copies.desired}`, label: 'copies healthy' });
  if (v.https) out.push({ value: 'HTTPS', label: v.https.valid ? (v.https.validUntil ? `valid until ${day(v.https.validUntil)}` : 'valid') : 'not valid yet' });
  return out;
}

/**
 * The "It's live" first look: three quiet stats swarmy measured from the
 * controller (`deploys.firstLook`) — first response, healthy copies, HTTPS.
 * Each shows only once measured; a skeleton while pending; a plain line when
 * the app couldn't be reached. Never coral: the screen's one coral is Open ↗.
 */
export function LiveFirstLook({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.deploys.firstLook.queryOptions({ stack }), staleTime: 10_000, retry: false });
  const box = 'calm-card flex flex-col gap-3 px-5 py-4';
  if (q.isPending) {
    return (
      <div className={box} aria-busy="true" aria-label="Checking it from swarmy">
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="shimmer-line h-5 w-16 rounded" />
              <div className="shimmer-line h-3 w-20 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const unreachable = q.isError || (q.data.response !== null && !q.data.response.ok);
  const shown = q.data ? stats(q.data) : [];
  if (!unreachable && shown.length === 0) return null;
  return (
    <section aria-label="First look" className={box}>
      {shown.length ? (
        <dl className="grid grid-cols-3 gap-4">
          {shown.map((s) => (
            <Stat key={s.label} {...s} />
          ))}
        </dl>
      ) : null}
      {unreachable ? (
        <p className="text-muted-foreground text-[13px]">
          Couldn’t reach it from swarmy yet ·{' '}
          <button type="button" onClick={() => void q.refetch()} className="text-foreground min-h-11 font-semibold underline-offset-2 hover:underline sm:min-h-0">
            retry
          </button>
        </p>
      ) : null}
    </section>
  );
}
