import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage, CodeView, Say, SayHeader, Section, StatusWord, Tech } from '@/components/calm';
import { SkeletonBody } from '@/components/states';
import { relTime } from '@/lib/format';
import { BuildImageCard } from './build-image-card';
import { BuildLayers } from './build-layers';
import { parseBuildLayers, toLogLines } from './build-log-parse';
import { BuildLogViewer } from './build-log-viewer';
import { BuildOutcome } from './build-outcome';
import { outcomeLine } from './build-stage-model';
import { BuildStagesRail } from './build-stages-rail';
import { BUILD_TONE, BUILD_WORD, repoName } from './builds-list';
import { buildStrategyLabel } from './build-strategy';
import { useBuildLog } from './use-build-log';

const RUNNING = new Set(['queued', 'building', 'pushing']);

/** One build: what it is, how each stage went, and the log (live while it runs). */
export function BuildDetailPage({ buildId }: { buildId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.cicd.getBuild.queryOptions({ buildId }),
    // Poll while anything is still moving: the build itself, then scan/sign/rollout after it.
    refetchInterval: (query) => {
      const b = query.state.data;
      return !b || RUNNING.has(b.status) || b.stages.some((s) => s.outcome === 'running') ? 3000 : false;
    },
  });
  const build = q.data;
  const status = build?.status ?? 'building';
  const live = RUNNING.has(status);
  const repo = build ? repoName(build.repoUrl) : buildId;
  const tone = BUILD_TONE[status] ?? 'idle';
  const { chunks } = useBuildLog(buildId, live);
  const lines = React.useMemo(() => toLogLines(chunks), [chunks]);
  const layers = React.useMemo(() => parseBuildLayers(lines.map((l) => l.text).join('\n')), [lines]);
  const outcome = build ? outcomeLine(build) : null;

  return (
    <CalmPage
      crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'CI & registry', to: '/ci' }, { label: build?.commit?.slice(0, 7) ?? 'Build' }]}
      aside={
        build ? (
          <>
            <CodeView title="This build as data" tabs={[{ label: 'JSON', code: JSON.stringify(build, null, 2) }]} source="readonly" />
            {build.image ? <BuildImageCard image={build.image} /> : null}
            <BuildLayers layers={layers} live={live} />
          </>
        ) : undefined
      }
    >
      {q.isLoading ? (
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
          {build ? <BuildStagesRail build={build} /> : null}
          <Section title="Log" hint={live ? 'streaming live' : undefined} action={<StatusWord tone={tone} word={BUILD_WORD[status] ?? status} pulse={live} />}>
            <BuildLogViewer lines={lines} live={live} />
          </Section>
          {outcome ? <BuildOutcome outcome={outcome} /> : null}
        </>
      )}
    </CalmPage>
  );
}
