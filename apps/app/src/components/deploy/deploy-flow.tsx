import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CalmTopBar } from '@/components/calm';
import { deployHandoff, dismissDeploy } from './deploy-handoff';
import { Elapsed } from './deploy-elapsed';
import { DeploySecretsBanner } from './deploy-secrets-banner';
import { DeployingView } from './deploying-view';
import { LiveView } from './live-view';
import { useDeployProgress } from './use-deploy-progress';

/**
 * The app page right after a deploy: "Deploying <name>…" until every step is
 * done, then "It's live." Pins itself into the URL (`?deployed=1`) so the
 * Live screen survives the moment the app starts to look normal; once the
 * person has seen it live and moves on (the canvas, the Domains tab, or any
 * other page) it is dismissed and a revisit shows the normal workspace.
 */
export function DeployFlow({ stack, pinned }: { stack: string; pinned: boolean }): React.JSX.Element {
  const navigate = useNavigate();
  const [handoff] = React.useState(() => deployHandoff(stack));
  const startedAt = handoff?.startedAt ?? null;
  const watch = useDeployProgress(stack, handoff?.result ?? null, startedAt, handoff?.deployId ?? null);
  const [liveAt, setLiveAt] = React.useState<number | null>(null);
  const seenLive = React.useRef(false);

  React.useEffect(() => {
    if (!pinned) void navigate({ to: '/stacks/$name', params: { name: stack }, search: { deployed: 1 }, replace: true });
  }, [pinned, navigate, stack]);

  React.useEffect(() => {
    if (watch.ready && watch.live && liveAt === null) {
      setLiveAt(Date.now());
      seenLive.current = true;
    }
  }, [watch.ready, watch.live, liveAt]);

  // Leaving after it went live dismisses it; leaving mid-deploy doesn't.
  React.useEffect(() => () => void (seenLive.current && dismissDeploy(stack)), [stack]);

  const leave = (): void => dismissDeploy(stack);
  const banner = <DeploySecretsBanner notes={handoff?.result?.notes ?? []} />;

  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar
        crumbs={[{ label: 'Apps', to: '/' }, { label: stack }]}
        actions={liveAt === null && watch.since && !watch.failed ? <Elapsed since={watch.since} /> : undefined}
      />
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-6 pt-8 pb-28 lg:pb-16 xl:px-8">
        {liveAt !== null ? (
          <LiveView stack={stack} watch={watch} startedAt={watch.since ?? startedAt} liveAt={liveAt} onLeave={leave} banner={banner} afterLive={handoff?.result?.afterLive} />
        ) : (
          <DeployingView stack={stack} watch={watch} banner={banner} />
        )}
      </div>
    </div>
  );
}
