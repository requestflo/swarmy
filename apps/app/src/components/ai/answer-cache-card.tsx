import * as React from 'react';
import { Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { AnswerCacheRow } from './answer-cache-row';
import type { useAnswerCache } from './use-answer-cache';

/** "since 09:40" for the counters (they restart with the gateway). */
function sinceLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `since ${sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()}`;
}

/**
 * Answer cache, per route: repeat questions to `smart`/`fast`/… answered from
 * memory, separately for each app key. "Similar too" matches other wordings
 * through the `embed` route, which costs one embedding call per new question.
 */
export function AnswerCacheCard({ cache }: { cache: ReturnType<typeof useAnswerCache> }): React.JSX.Element {
  if (cache.pending) return <CardSkeleton lines={3} />;
  if (cache.error) {
    return (
      <div className="calm-card p-5">
        <p className="text-tone-bad text-sm">Couldn&apos;t load the answer cache.</p>
      </div>
    );
  }
  const on = cache.routes.filter((r) => r.setting).length;
  return (
    <Section
      id="ai-answer-cache"
      title="Answer cache"
      count={`${on} of ${cache.routes.length} on`}
      hint={[sinceLabel(cache.since), 'kept in memory, per app key'].filter(Boolean).join(' · ')}
    >
      <p className="text-muted-foreground text-[13px]">
        A question an app already asked gets the stored answer back at no cost.{' '}
        {cache.embedReady
          ? '“Similar too” also matches other wordings of it — each new question costs one call to embed.'
          : 'Add a provider that can embed to match other wordings too.'}{' '}
        Streaming requests always go to the model.
      </p>
      {cache.routes.length === 0 ? (
        <p className="text-muted-foreground text-sm">Add a provider first — its models appear here as fast, smart and your own names.</p>
      ) : (
        <div className="flex flex-col">
          {cache.routes.map((r) => (
            <AnswerCacheRow key={r.name} route={r} embedReady={cache.embedReady} saving={cache.saving} onSave={(c) => cache.save(r.name, c)} />
          ))}
        </div>
      )}
    </Section>
  );
}
