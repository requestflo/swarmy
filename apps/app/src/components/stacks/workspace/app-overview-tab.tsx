import * as React from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { CodeView } from '@/components/calm';
import { plural } from '@/components/apps/app-words';
import { useApps } from '@/components/apps/use-apps';
import { ServiceCanvas } from '@/components/canvas/service-canvas';
import { CardSkeleton } from '@/components/states';
import { AppAlreadyOn, appAlreadyOn } from './app-already-on';
import { appCodeTabs } from './app-code';
import { AppFacts } from './app-facts';
import { AppWorthDoing } from './app-worth-doing';
import { PartsList } from './parts-list';
import { ServiceSheet } from './service-sheet';
import { useAppFacts } from './use-app-facts';

/**
 * The app's Overview tab (RApp / AppCanvas): "How it is built" — the live
 * canvas with the selected part's sheet — and an aside with the one thing
 * worth doing, the facts, and what's already on. Code puts the live spec at
 * the top of the aside.
 */
export function AppOverviewTab({
  stack,
  part,
  onSelect,
  onOpen,
}: {
  stack: string;
  /** Selected part (service id) — its sheet shows at the bottom of the canvas. */
  part: string | undefined;
  onSelect: (id: string | undefined) => void;
  onOpen: (id: string, origin: { x: number; y: number } | null) => void;
}): React.JSX.Element {
  const a = useApps();
  const f = useAppFacts(stack);
  const app = [...a.apps, ...a.platform].find((x) => x.name === stack);
  const selected = app?.stat.services.find((s) => s.id === part);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:grid-rows-[auto_1fr] xl:gap-x-6">
      {/* Phone: the next action leads; xl: it tops the aside, beside the canvas. */}
      <div className="flex min-w-0 flex-col gap-4 xl:col-start-2 xl:row-start-1">
        {app ? (
          <>
            <CodeView title="How it is built, as code" tabs={appCodeTabs(app, f.stackId)} source="readonly" />
            <AppWorthDoing app={app} f={f} />
          </>
        ) : null}
      </div>
      <section aria-labelledby="built-h" className="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-span-2 xl:row-start-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 id="built-h" className="font-display text-[16.5px] font-bold tracking-[-0.01em]">
            How it is built
          </h2>
          {app ? (
            <span className="text-muted-foreground text-[12.5px]">
              {plural(app.stat.serviceCount, 'part')} working together<span className="hidden md:inline"> · click one</span>
            </span>
          ) : null}
        </div>
        {app ? (
          <div className="calm-card px-4 py-1 md:hidden">
            <PartsList services={app.stat.services} onOpen={(id) => onOpen(id, null)} />
          </div>
        ) : null}
        <div className="calm-card relative hidden h-[min(620px,calc(100dvh-16rem))] min-h-[420px] overflow-hidden p-0 md:block">
          <ReactFlowProvider key={stack}>
            <ServiceCanvas embedded stackFilter={stack} selectedId={part ?? ''} onOpenService={(id) => onSelect(id)} />
          </ReactFlowProvider>
          {selected ? (
            <ServiceSheet
              stack={stack}
              service={selected}
              onOpen={() => onOpen(selected.id, null)}
              onClose={() => onSelect(undefined)}
            />
          ) : null}
        </div>
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
    </div>
  );
}
