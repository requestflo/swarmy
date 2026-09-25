import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Depth, Say, Section, SectionLink, type Tone } from '@/components/calm';
import { DbClusterRow, type DbClusterRowView } from '@/components/stacks/db-cluster-row';
import { DbFailoverConfirm } from '@/components/stacks/db-failover-confirm';
import { DbStorageWarning } from '@/components/stacks/db-storage-warning';
import { PgChoiceCard } from './pg-choice-card';
import {
  HA_CHOICES,
  choiceFacts,
  cronWords,
  currentChoice,
  humanBytes,
  recommendedChoice,
  type HaChoice,
  type PgBackupFacts,
  type PgClusterFacts,
} from './pg-choices';

export type PgCluster = PgClusterFacts & DbClusterRowView;

/** One plain sentence for a Postgres cluster: how it's saved and how big. */
export function pgSentence(c: PgClusterFacts, b: PgBackupFacts | null): { text: string; size: string | null; tone: Tone } {
  const saved = cronWords(b?.cron ?? null);
  const size = humanBytes(b?.lastSizeBytes ?? null);
  if (b?.lastStatus === 'failed') return { text: `${saved ? `Saved ${saved}, but the` : 'The'} last save failed.`, size, tone: 'bad' };
  const text = saved ? `Saved ${saved}${c.pitr || b?.pitr ? ', and can be rewound to any moment since' : ''}.` : 'Not saved on a schedule yet.';
  return { text, size, tone: saved ? 'ok' : 'warn' };
}

function todayLine(c: PgClusterFacts, choice: HaChoice | null): React.ReactNode {
  if (choice === null) return `It uses a custom shape (${c.topology}); change it below at Controls.`;
  if (choice === 'one') return 'Today there is one copy.';
  const lag = c.maxLagSeconds;
  const behind = lag !== undefined && lag >= 5;
  const missing = c.replicas.running < c.replicas.desired;
  return (
    <>
      Today a standby copy follows every change{choice === 'auto' ? ' and switch-over is on' : ''}.{' '}
      {missing ? <Say tone="warn">{c.replicas.desired - c.replicas.running} of {c.replicas.desired} standby copies {c.replicas.desired - c.replicas.running === 1 ? 'isn’t' : 'aren’t'} running.</Say> : null}
      {behind && !missing ? <Say tone="warn">It is {lag} s behind.</Say> : null}
    </>
  );
}

/**
 * A managed Postgres database on the Data tab (RDatabase board): the sentence,
 * the three honest "if a server fails" choices, and — from Controls — the copy
 * scaler, hosts, topology and backups.
 */
export function PgHaSection({
  stack,
  cluster,
  backup,
  selected,
  onSelect,
  autoBlocked,
}: {
  stack: string;
  cluster: PgCluster;
  backup: PgBackupFacts | null;
  selected: HaChoice | null;
  onSelect: (c: HaChoice) => void;
  autoBlocked: string | null;
}): React.JSX.Element {
  const c = cluster;
  const today = currentChoice(c);
  const rec = recommendedChoice(today, !autoBlocked);
  const s = pgSentence(c, backup);
  const groupId = React.useId();
  return (
    <Section
      title={`The ${c.name} database`}
      hint="Postgres"
      action={
        <Link to="/stacks/$name/studio" params={{ name: stack }} search={{ db: c.name }} className="min-h-11 content-center">
          <SectionLink>Open studio →</SectionLink>
        </Link>
      }
    >
      <p className="text-[14px] leading-relaxed">
        {s.tone === 'ok' ? s.text : <Say tone={s.tone}>{s.text}</Say>}
        {s.size ? <span className="text-muted-foreground"> {s.size}.</span> : null} <span className="text-muted-foreground">{todayLine(c, today)}</span>
      </p>
      {c.pendingFailover ? <DbFailoverConfirm stack={stack} cluster={c.name} pending={c.pendingFailover} /> : null}
      {c.storage ? <DbStorageWarning stack={stack} cluster={c.name} storage={c.storage} /> : null}
      {today !== null ? (
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-[13.5px] font-semibold">If a server fails</legend>
          {HA_CHOICES.map((ch) => (
            <PgChoiceCard
              key={ch}
              name={groupId}
              value={ch}
              facts={choiceFacts(ch, c, backup)}
              selected={(selected ?? rec ?? today) === ch}
              current={today === ch}
              recommended={rec === ch}
              blocked={ch === 'auto' && today !== 'auto' ? autoBlocked : null}
              onSelect={() => onSelect(ch)}
            />
          ))}
        </fieldset>
      ) : null}
      <Depth at="controls">
        <DbClusterRow stack={stack} cluster={c} />
      </Depth>
    </Section>
  );
}
