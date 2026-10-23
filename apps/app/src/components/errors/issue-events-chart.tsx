import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { compact, shortRelease, timeAgo } from './errors-shared';
import { trendPosition } from './issue-chart-math';

interface Introduced {
  version: string;
  deployedAt: string | null;
}

const BAR = 10;
const H = 64;

/**
 * The issue's last 24 hours, one bar an hour, with a mark where the release
 * that introduced it was deployed. A deploy before the window is said in words.
 */
export function IssueEventsChart({
  trend,
  introduced,
  footer,
}: {
  trend: number[] | null;
  introduced: Introduced | null;
  footer?: React.ReactNode;
}): React.JSX.Element {
  if (!trend) return <CardSkeleton lines={3} />;
  const total = trend.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...trend);
  const pos = trendPosition(introduced?.deployedAt ?? null);
  const version = introduced ? shortRelease(introduced.version) : null;
  const flip = pos !== null && pos > 0.6;
  const label = `${total} events in the last 24 hours${version && pos !== null ? `; ${version} deployed ${timeAgo(introduced?.deployedAt)}` : ''}`;

  return (
    <Section title="Last 24 hours" hint={`${compact(total)} events · peak ${compact(max)} an hour`}>
      <div className="relative pt-5">
        <svg viewBox={`0 0 ${BAR * trend.length} ${H}`} preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label={label}>
          {trend.map((v, i) => {
            const h = v === 0 ? 1 : Math.max(2, (v / max) * H);
            return (
              <rect key={i} x={i * BAR + 1.5} y={H - h} width={BAR - 3} height={h} className={v ? 'fill-status-offline/70' : 'fill-muted-foreground/25'}>
                <title>{`${trend.length - 1 - i === 0 ? 'this hour' : `${trend.length - 1 - i} h ago`} · ${v} events`}</title>
              </rect>
            );
          })}
        </svg>
        {pos !== null && version ? (
          <div aria-hidden className="border-foreground/60 absolute inset-y-0 border-l border-dashed" style={{ left: `${pos * 100}%` }}>
            <span className={cn('absolute top-0 font-mono text-[11px] whitespace-nowrap', flip ? 'right-1.5' : 'left-1.5')}>
              ▲ {version} deployed
            </span>
          </div>
        ) : null}
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[11px]">
        <span>24 h ago</span>
        <span>now</span>
      </div>
      {version && pos === null && introduced?.deployedAt ? (
        <p className="text-muted-foreground text-sm">
          It came in with {version}, deployed {timeAgo(introduced.deployedAt)} — before this window.
        </p>
      ) : null}
      {footer}
    </Section>
  );
}
