import * as React from 'react';
import type { ResilienceScoreView } from '@swarmy/core';
import { cn } from '@swarmy/ui';
import { CountUp } from '@/components/count-up';

/** Ring colour follows the cluster vocabulary: green ≥90, amber ≥65, crimson below. */
function ringClass(score: number): string {
  if (score >= 90) return 'text-status-online';
  if (score >= 65) return 'text-status-warning';
  return 'text-status-offline';
}

const R = 64;
const CIRC = 2 * Math.PI * R;

/** The score ring: big mono number, grade, "Production readiness: NN%". */
export function ScoreRing({ score }: { score: ResilienceScoreView }): React.JSX.Element {
  const dash = (score.score / 100) * CIRC;
  return (
    <div className="card-pop flex flex-col items-center gap-4 p-6">
      <div className="relative size-44">
        <svg viewBox="0 0 160 160" className="size-full -rotate-90">
          <circle
            cx="80"
            cy="80"
            r={R}
            fill="none"
            strokeWidth="12"
            className="stroke-border"
          />
          <circle
            cx="80"
            cy="80"
            r={R}
            fill="none"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC - dash}`}
            className={cn('stroke-current transition-all duration-700', ringClass(score.score))}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="mono-data text-5xl font-bold">
            <CountUp value={score.score} />
          </span>
          <span className={cn('mono-label mt-1', ringClass(score.score))}>Grade {score.grade}</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-sm font-bold">{score.headline}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {score.counts.crit + score.counts.warn + score.counts.info === 0
            ? `All ${score.checksRun} checks pass. You'd survive a bad day.`
            : [
                score.counts.crit ? `${score.counts.crit} critical` : null,
                score.counts.warn ? `${score.counts.warn} warning${score.counts.warn === 1 ? '' : 's'}` : null,
                score.counts.info ? `${score.counts.info} note${score.counts.info === 1 ? '' : 's'}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </p>
      </div>
    </div>
  );
}
