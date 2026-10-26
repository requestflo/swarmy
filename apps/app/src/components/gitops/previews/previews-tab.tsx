import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CodeView, SayHeader, SectionLink, Say } from '@/components/calm';
import { TabBody, plural } from '@/components/app-tabs/tab-body';
import { CardSkeleton, ErrorState, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { findStackApp } from '../gitops-types';
import { NewPreview } from './new-preview';
import { PreviewDetail } from './preview-detail';
import { PreviewList } from './preview-list';
import { PreviewRulesCard } from './preview-rules';
import { previewsCode } from './previews-code';

/**
 * Config › Branch previews (board BranchPreviews): every preview with its
 * state, address, data and time left; the rules (swarmy.yaml's, else saved
 * here — changed at Controls); the picked preview's data story; and a new
 * preview from any branch, no pull request needed.
 */
export function PreviewsTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const apps = useQuery({ ...trpc.apps.list.queryOptions(), refetchInterval: 15_000 });
  const [picked, setPicked] = React.useState<string | null>(null);
  const match = apps.data ? findStackApp(apps.data, stack) : null;
  if (apps.isError) return <ErrorState title="Couldn't load this app's previews" error={apps.error} retry={() => void apps.refetch()} />;
  if (!apps.data) return <TabBody header={<HeaderSkeleton />}><CardSkeleton lines={4} /></TabBody>;
  if (!match) {
    return (
      <TabBody header={<SayHeader size="md" title={<>{stack} doesn’t deploy from git, <em>so it has no previews.</em></>} lede="Link a repo with a swarmy.yaml and every pull request — or any branch you pick — gets its own copy of the app." />}>
        <Link to="/ci" className="w-fit pointer-coarse:min-h-11 content-center">
          <SectionLink>Link a repo →</SectionLink>
        </Link>
      </TabBody>
    );
  }
  const { app } = match;
  const previews = app.previews;
  const live = previews.filter((p) => p.status === 'applied').length;
  const current = previews.find((p) => p.stack === picked) ?? (match.kind === 'preview' ? match.preview : previews[0]);
  const title = previews.length ? (
    <>
      {app.appName ?? stack} has {plural(previews.length, 'preview')};{' '}
      {live === previews.length ? <em>{previews.length === 1 ? 'it’s live.' : 'all are live.'}</em> : <Say tone="warn">{`${previews.length - live} ${previews.length - live === 1 ? 'isn’t' : 'aren’t'} live.`}</Say>}
    </>
  ) : (
    <>{app.appName ?? stack} has no previews <em>right now.</em></>
  );

  return (
    <TabBody
      asideAt="code"
      header={<SayHeader size="md" title={title} lede={`Any branch gets its own copy of ${app.appName ?? stack} — not just pull requests. Same build, same swarmy.yaml.`} />}
      aside={<CodeView title="Previews as code" tabs={previewsCode(app, current?.branch ?? '')} source="yaml" />}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {previews.length ? (
            <PreviewList previews={previews} rules={app.previewRules} selected={current?.stack ?? null} onSelect={setPicked} />
          ) : (
            <p className="text-muted-foreground text-[13.5px]">Open a pull request{app.previewRules?.branches.length ? ' or push a matching branch' : ''} and swarmy starts one — or start one from a branch here.</p>
          )}
          <PreviewRulesCard app={app} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {current ? <PreviewDetail key={current.stack} app={app} preview={current} /> : null}
          <NewPreview app={app} onCreated={setPicked} />
        </div>
      </div>
    </TabBody>
  );
}
