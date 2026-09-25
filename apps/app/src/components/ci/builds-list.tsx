import * as React from 'react';
import { CalmRow, RowList, Section, type Tone } from '@/components/calm';
import { relTime } from '@/lib/format';
import { type BuildStrategy, buildStrategyLabel } from './build-strategy';

export interface BuildRow extends BuildStrategy {
  id: string;
  repoUrl: string;
  commit: string | null;
  status: string;
  image: string | null;
  startedAt: string | null;
}

export const BUILD_TONE: Record<string, Tone> = { succeeded: 'ok', building: 'info', pushing: 'info', queued: 'info', failed: 'bad', canceled: 'idle' };
export const BUILD_WORD: Record<string, string> = { succeeded: 'Built', building: 'Building', pushing: 'Pushing', queued: 'Queued', failed: 'Failed', canceled: 'Canceled' };

export function repoName(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, '');
}

/** Recent builds, each a row into its live log. */
export function BuildsList({ builds }: { builds: BuildRow[] }): React.JSX.Element {
  const running = builds.filter((b) => BUILD_TONE[b.status] === 'info').length;
  return (
    <Section title="Builds" count={`${builds.length} recent${running ? ` · ${running} running` : ''}`} flush>
      <RowList label="Builds">
        {builds.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">No builds yet. Push to a connected repo, or start one from an app, and the log streams in live.</p>
        ) : (
          builds.map((b) => (
            <CalmRow
              key={b.id}
              tone={BUILD_TONE[b.status] ?? 'idle'}
              name={repoName(b.repoUrl).split('/').slice(-1)[0] ?? b.repoUrl}
              sub={b.commit ? b.commit.slice(0, 7) : undefined}
              say={`${b.startedAt ? `started ${relTime(b.startedAt)}` : 'not started'}${buildStrategyLabel(b) ? ` · ${buildStrategyLabel(b)}` : ''}`}
              tech={b.image ?? repoName(b.repoUrl)}
              word={BUILD_WORD[b.status] ?? b.status}
              to="/ci/$buildId"
              params={{ buildId: b.id }}
            />
          ))
        )}
      </RowList>
    </Section>
  );
}
