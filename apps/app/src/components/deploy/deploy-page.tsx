import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage, SayHeader } from '@/components/calm';
import { ErrorState } from '@/components/states';
import { GitNewAppCard } from '@/components/ci/git-new-app-card';
import type { DeploySource } from './deploy-choice';
import { DeployCode } from './deploy-code';
import { DeployGitAside } from './deploy-git-aside';
import { DeployTemplateAside } from './deploy-template-aside';
import { SourceCards } from './source-cards';
import { TemplateShelf } from './template-shelf';
import { useServerRoom } from './use-server-room';

/**
 * Deploy an app (board 2 + RDeploy): "What are you putting online?" — four
 * source cards (template · compose · image · git), then twelve templates and
 * the picked one in the aside with its one coral step on to Configure.
 * Compose and image open their own pages; git opens its wizard here.
 */
export function DeployPage(): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.blueprints.list.queryOptions());
  const all = React.useMemo(() => (list.data ?? []).filter((m) => !m.docOnly), [list.data]);
  const room = useServerRoom();
  const [source, setSource] = React.useState<DeploySource>('template');
  const [picked, setPicked] = React.useState<string | null>(null);
  const template = all.find((m) => m.id === picked) ?? all.find((m) => m.id === 'ghost') ?? all[0] ?? null;

  const pick = (id: string): void => {
    setPicked(id);
    if (window.matchMedia('(max-width: 1279px)').matches) {
      requestAnimationFrame(() => document.getElementById('deploy-aside')?.scrollIntoView({ behavior: 'smooth' }));
    }
  };

  const aside =
    source === 'git' ? (
      <>
        <DeployCode source="git" template={null} />
        <DeployGitAside />
      </>
    ) : template ? (
      <>
        <DeployCode source="template" template={template} />
        <div id="deploy-aside" className="scroll-mt-4 xl:sticky xl:top-4">
          <DeployTemplateAside meta={template} />
        </div>
      </>
    ) : list.isPending ? (
      <div className="shimmer-line h-96 rounded-2xl" />
    ) : null;

  return (
    <CalmPage
      wide
      crumbs={[{ label: 'Overview', to: '/overview' }, { label: 'deploy' }]}
      actions={
        room.roomiest ? (
          <span className="text-muted-foreground hidden text-[13px] md:inline">
            Lands on <span className="text-foreground font-mono">{room.roomiest.name}</span> unless you say otherwise
          </span>
        ) : null
      }
      aside={aside}
    >
      <SayHeader eyebrow="Nothing runs until you press Deploy" title="What are you putting online?" />
      <SourceCards value={source} onPick={setSource} templateCount={list.isPending ? null : all.length} />
      {source === 'git' ? (
        <GitNewAppCard onClose={() => setSource('template')} />
      ) : list.isError ? (
        <ErrorState title="Couldn't load the templates." error={list.error} retry={() => void list.refetch()} />
      ) : (
        <TemplateShelf all={all} pending={list.isPending} selected={template?.id ?? null} onPick={pick} />
      )}
    </CalmPage>
  );
}
