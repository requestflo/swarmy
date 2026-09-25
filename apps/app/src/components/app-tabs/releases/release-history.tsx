import * as React from 'react';
import type { ReleaseView } from '@swarmy/core';
import { CalmRow, Section } from '@/components/calm';
import { ReleaseDetailCard } from '@/components/releases/release-detail-card';
import { relativeTime } from '@/components/releases/release-status';
import { RELEASE_TONE, RELEASE_WORD, actorName, releaseLabel } from './release-label';

/** Every version of the app, newest first; picking one shows what changed and lets you put it back. */
export function ReleaseHistory({ rows }: { rows: ReleaseView[] }): React.JSX.Element {
  const [selected, setSelected] = React.useState<string | null>(null);
  const pick = rows.find((r) => r.id === selected);
  return (
    <>
      <Section title="History" count={rows.length} hint="newest first" flush>
        <div className="flex flex-col">
          {rows.map((r) => (
            <CalmRow
              key={r.id}
              tone={RELEASE_TONE[r.status]}
              name={releaseLabel(r)}
              sub={relativeTime(r.createdAt)}
              say={`${r.notes?.toLowerCase().includes('rollback') ? 'Put back' : 'Deployed'} by ${actorName(r.actor)}${
                r.images.length > 1 ? ` · ${r.images.length} services` : ''
              }`}
              tech={r.images.map((i) => i.image.split('/').pop()).join(' · ')}
              word={RELEASE_WORD[r.status]}
              onClick={() => setSelected((s) => (s === r.id ? null : r.id))}
              className={selected === r.id ? 'bg-foreground/[0.03]' : undefined}
            />
          ))}
        </div>
      </Section>
      {pick ? (
        <Section title={`What ${releaseLabel(pick)} changed`}>
          <ReleaseDetailCard release={pick} label={releaseLabel(pick)} />
        </Section>
      ) : null}
    </>
  );
}
