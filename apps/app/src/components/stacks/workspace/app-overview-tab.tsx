import * as React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { CodeView } from '@/components/calm';
import { plural } from '@/components/apps/app-words';
import { useApps } from '@/components/apps/use-apps';
import { AppCanvasFrame } from '@/components/canvas/app-canvas-frame';
import { BuildChips } from '@/components/canvas/build-chips';
import { ComposePane } from '@/components/canvas/compose-pane';
import { ServiceSettingsPanel } from '@/components/service-settings/service-settings-panel';
import { CardSkeleton } from '@/components/states';
import { AppAlreadyOn, appAlreadyOn } from './app-already-on';
import { appCodeTabs } from './app-code';
import { AppFacts } from './app-facts';
import { AppWorthDoing } from './app-worth-doing';
import { useAppFacts } from './use-app-facts';

/**
 * The app's Overview tab (RApp / AppCanvas): "How it is built" — the live
 * canvas with the selected part's settings panel — and an aside with the one thing
 * worth doing, the facts, and what's already on. Code puts the live spec at
 * the top of the aside.
 */
export function AppOverviewTab({
  stack,
  part,
  onSelect,
}: {
  stack: string;
  /** Selected part (service id) — its settings panel opens over the canvas. */
  part: string | undefined;
  onSelect: (id: string | undefined) => void;
}): React.JSX.Element {
  const a = useApps();
  const f = useAppFacts(stack);
  const app = [...a.apps, ...a.platform].find((x) => x.name === stack);
  const [compose, setCompose] = React.useState(false);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:grid-rows-[auto_1fr] xl:gap-x-6">
      {/* Phone: the next action leads; xl: it tops the aside, beside the canvas. */}
      <div className="flex min-w-0 flex-col gap-4 xl:col-start-2 xl:row-start-1">
        {app && compose ? (
          <ComposePane app={app} className="calm-card hidden max-h-[min(620px,calc(100dvh-16rem))] xl:flex" />
        ) : null}
        {app ? (
          <>
            <CodeView title="How it is built, as code" tabs={appCodeTabs(app, f.stackId)} source="readonly" />
            <AppWorthDoing app={app} f={f} />
          </>
        ) : null}
      </div>
      <section aria-labelledby="built-h" className="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-span-2 xl:row-start-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-2">
          <h2 id="built-h" className="font-display text-[16.5px] font-bold tracking-[-0.01em]">
            How it is built
          </h2>
          {app ? (
            <span className="text-muted-foreground text-[12.5px]">
              {plural(app.stat.serviceCount, 'part')} working together<span className="hidden md:inline"> · click one</span>
            </span>
          ) : null}
          {app ? (
            <span className="md:ml-auto">
              <BuildChips stack={stack} services={app.stat.services} />
            </span>
          ) : null}
        </div>
        {app ? (
          <ReactFlowProvider key={stack}>
            <AppCanvasFrame app={app} part={part} onSelect={(id) => onSelect(id)} compose={compose} onCompose={() => setCompose((c) => !c)} />
          </ReactFlowProvider>
        ) : (
          <CardSkeleton lines={8} />
        )}
      </section>
      <aside aria-label="About this app" className="flex min-w-0 flex-col gap-4 xl:col-start-2 xl:row-start-2">
        {app ? (
          <>
            <AppFacts stack={stack} f={f} />
            {f.settled ? <AppAlreadyOn items={appAlreadyOn(stack, f)} /> : null}
          </>
        ) : (
          <CardSkeleton lines={4} />
        )}
      </aside>
      {part ? <ServiceSettingsPanel serviceId={part} onClose={() => onSelect(undefined)} /> : null}
    </div>
  );
}
