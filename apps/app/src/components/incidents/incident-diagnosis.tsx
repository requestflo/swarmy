import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import { listWords, type Blast } from './blast-radius';
import { DEPLOY_SUSPECT_MIN, type Guess } from './incident-guess';

const eyebrow = 'text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase';

/** "swarmy's best guess": the plain-words hypothesis, and what to do about it. */
export function BestGuessCard({ guess, open }: { guess: Guess | undefined; open: boolean }): React.JSX.Element {
  if (!guess) return <CardSkeleton />;
  const putBack = open && guess.cause === 'deploy' ? guess.putBack : null;
  const label = putBack ? releaseLabel(putBack) : null;
  return (
    <section aria-label="swarmy’s best guess" className="calm-card flex flex-col gap-2.5 px-5 py-4">
      <p className={eyebrow}>swarmy’s best guess</p>
      <h2 className="font-display text-[17px] leading-snug font-bold">{guess.headline}</h2>
      {guess.lines.length ? <p className="text-foreground/80 text-[13.5px] leading-relaxed">{guess.lines.join(' ')}</p> : null}
      <Tech>
        rules: a release in the {DEPLOY_SUSPECT_MIN} min before it opened · an offline or busy server · the slowest span (self time) of the worst error trace in the last hour
        {guess.suspect ? ` · suspect ${guess.suspect.id}` : ''}
      </Tech>
      {putBack || guess.traceId ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {putBack && label ? (
            <RollbackConfirm release={putBack} label={label} trigger={<Button size="sm" className="pointer-coarse:min-h-11">Put back {label}</Button>} />
          ) : null}
          {guess.traceId ? (
            <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
              <Link to="/observability/$traceId" params={{ traceId: guess.traceId }}>Open trace</Link>
            </Button>
          ) : null}
          {putBack ? <span className="text-muted-foreground font-mono text-[11px]">one copy at a time · your data isn’t touched</span> : null}
        </div>
      ) : null}
      {putBack ? (
        <Depth at="controls">
          <Tech>releases.rollback · redeploys {putBack.images.map((i) => i.image).join(', ')} as a new release</Tech>
        </Depth>
      ) : null}
    </section>
  );
}

/** "Blast radius": where it hit, what it didn't, data, and roughly who saw it. */
export function BlastRadiusCard({ app, part, blast }: { app: string | null; part: string | null; blast: Blast | null | undefined }): React.JSX.Element {
  if (blast === undefined) return <CardSkeleton />;
  return (
    <section aria-label="Blast radius" className="calm-card flex flex-col gap-2.5 px-5 py-4">
      <p className={eyebrow}>Blast radius</p>
      {!blast || !app ? (
        <p className="text-muted-foreground text-[13.5px]">swarmy can’t tell which app this hit.</p>
      ) : (
        <>
          <p className="text-[14px] leading-snug">
            <strong className="font-semibold">{blast.address ?? app}</strong>
            {' '}· {part ? `${part} in ${app}` : app}
          </p>
          <p className="text-foreground/80 text-[13.5px] leading-relaxed">
            {blast.noDataLost ? 'No data lost: nothing that stores data is failing. ' : ''}
            {blast.alsoHit.length ? `${listWords(blast.alsoHit)} ${blast.alsoHit.length === 1 ? 'shares' : 'share'} a failing part. ` : ''}
            {blast.unaffected.length ? `${listWords(blast.unaffected)} ${blast.unaffected.length === 1 ? 'is' : 'are'} unaffected.` : ''}
          </p>
          {blast.visitors !== null ? (
            <p className="text-muted-foreground mt-auto font-mono text-[12px]">~{blast.visitors} visitors affected <span className="text-muted-foreground/80">(approximate)</span></p>
          ) : null}
          <Tech>
            failing: {blast.failing.join(', ') || 'none named'} · visitors ≈ 5xx per minute at the front door × minutes open
          </Tech>
        </>
      )}
    </section>
  );
}
