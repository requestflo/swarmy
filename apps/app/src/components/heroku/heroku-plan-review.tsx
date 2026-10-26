import * as React from 'react';
import type { HerokuPlanItem } from '@swarmy/app-config';
import { CalmRow, RowList, Section, type Tone } from '@/components/calm';
import { GitHerokuGaps } from '@/components/ci/git-heroku-gaps';
import { HerokuPlanConfig } from './heroku-plan-config';
import type { HerokuImportView } from './heroku-types';

function Rows({ items, tone, word }: { items: HerokuPlanItem[]; tone: Tone; word: (i: HerokuPlanItem) => string }): React.JSX.Element {
  return (
    <RowList>
      {items.map((i) => (
        <CalmRow key={i.name} tone={tone} name={i.name} say={i.say} tech={i.tech} word={word(i)} wordTone="idle" />
      ))}
    </RowList>
  );
}

const ROLE: Record<string, string> = { web: 'Web', worker: 'Worker', clock: 'Clock' };

/**
 * Step 2: the plan in plain words — what each Heroku process becomes, the
 * data swarmy runs, the config (sealed or not), the domains, and everything
 * that didn't come across with what to do about it. Nothing has run yet.
 */
export function HerokuPlanReview({ view }: { view: HerokuImportView }): React.JSX.Element {
  const p = view.plan;
  return (
    <>
      <Section title="What runs" count={p.services.length} flush>
        <RowList>
          {p.services.map((s) => (
            <CalmRow key={s.name} tone="info" name={s.name} say={s.say} tech={s.tech} word={ROLE[s.role]} wordTone="idle" />
          ))}
        </RowList>
      </Section>

      <Section title="Data" count={p.data.length || undefined} flush={p.data.length > 0}>
        {p.data.length ? (
          <Rows items={p.data} tone="mesh" word={(d) => (view.copyable.includes(d.name) ? 'Data can be copied' : 'Starts empty')} />
        ) : (
          <p className="text-muted-foreground text-[13.5px]">No Heroku Postgres or Redis: nothing to move.</p>
        )}
      </Section>

      <HerokuPlanConfig view={view} />

      {p.domains.length ? (
        <Section title="Domains" count={p.domains.length}>
          <p className="text-muted-foreground text-[13.5px] leading-relaxed">
            <span className="text-foreground font-mono">{p.domains.join(', ')}</span> move to web. Heroku keeps serving them until
            their DNS points at your servers, then swarmy gets the certificates.
          </p>
        </Section>
      ) : null}

      {p.jobs.length ? (
        <Section title="Scheduled jobs" count={p.jobs.length} flush>
          <Rows items={p.jobs} tone="idle" word={() => 'Job'} />
        </Section>
      ) : null}

      <section className="calm-card px-5 py-4">
        <GitHerokuGaps untranslated={[...p.todo, ...p.handled]} changes={view.changes} />
      </section>
    </>
  );
}
