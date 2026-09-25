import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage, CodeView, Say, SayHeader, Section, StatusWord, Tech } from '@/components/calm';
import { SkeletonBody } from '@/components/states';
import { relTime } from '@/lib/format';
import { BuildLogViewer } from './build-log-viewer';
import { BUILD_TONE, BUILD_WORD, repoName } from './builds-list';
import { buildStrategyLabel } from './build-strategy';

const RUNNING = new Set(['queued', 'building', 'pushing']);

/** One build: what it is, how it went, and the log (live while it runs). */
export function BuildDetailPage({ buildId }: { buildId: string }): React.JSX.Element {
  const trpc = useTRPC();
  // The build row comes from the (refetching) list; cheap and avoids a new query.
  const builds = useQuery({ ...trpc.cicd.listBuilds.queryOptions({}), refetchInterval: 4000 });
  const build = builds.data?.find((b) => b.id === buildId);
  const status = build?.status ?? 'building';
  const live = RUNNING.has(status);
  const repo = build ? repoName(build.repoUrl) : buildId;
  const tone = BUILD_TONE[status] ?? 'idle';

  return (
    <CalmPage
      crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'CI & registry', to: '/ci' }, { label: build?.commit?.slice(0, 7) ?? 'Build' }]}
      aside={build ? <CodeView title="This build as data" tabs={[{ label: 'JSON', code: JSON.stringify(build, null, 2) }]} source="readonly" /> : undefined}
    >
      {builds.isLoading ? (
        <SkeletonBody variant="list" />
      ) : (
        <>
          <SayHeader
            eyebrow="Build"
            title={
              <>
                {repo.split('/').slice(-1)[0]}{' '}
                {status === 'failed' ? <Say tone="bad">didn’t build.</Say> : live ? <Say tone="info">is building.</Say> : status === 'succeeded' ? <Say tone="ok">built.</Say> : <em>{status}.</em>}
              </>
            }
            lede={build ? `${build.commit ? `Commit ${build.commit.slice(0, 7)}` : 'No commit'}${build.startedAt ? `, started ${relTime(build.startedAt)}` : ''}.${build.image ? ' Pushed as an image your apps can run.' : ''}` : 'This build is no longer in the recent list.'}
          />
          {build ? <Tech>{`${build.image ?? '—'} · ${repo}${buildStrategyLabel(build) ? ` · ${buildStrategyLabel(build)}` : ''}`}</Tech> : null}
          <Section title="Log" hint={live ? 'streaming live' : undefined} action={<StatusWord tone={tone} word={BUILD_WORD[status] ?? status} pulse={live} />}>
            <BuildLogViewer buildId={buildId} live={live} />
          </Section>
        </>
      )}
    </CalmPage>
  );
}
