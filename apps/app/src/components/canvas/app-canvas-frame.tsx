import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useReactFlow } from '@xyflow/react';
import { SplineIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import type { AppItem } from '@/components/apps/use-apps';
import { useMedia } from '@/components/estate-map/use-media';
import { PartsList } from '@/components/stacks/workspace/parts-list';
import { isManagedMember, type AnyCanvasNode } from './canvas-extras';
import { CanvasTools } from './canvas-toolbar';
import { ComposePane } from './compose-pane';
import { ConnectModeContext } from './connect/connect-context';
import { ConnectPanel, type ConnectState } from './connect/connect-panel';
import { bucketTarget } from './data-nodes';
import { ServiceCanvas } from './service-canvas';
import { useCanvasExtras } from './use-canvas-extras';

const NONE: ConnectState = { from: null, to: null };

/**
 * "How it is built" (board AppCanvas): the canvas with its tool row, the live
 * compose beside it (inside the card below xl; xl puts it at the top of the
 * aside, so the canvas keeps its width), and connect mode — drag a part onto
 * a store, click one then the other, or pick both in the panel. Phones get the
 * parts as rows and the same connect panel. Lives under a ReactFlowProvider.
 */
export function AppCanvasFrame({
  app,
  part,
  onSelect,
  compose,
  onCompose,
}: {
  app: AppItem;
  part: string | undefined;
  onSelect: (id: string) => void;
  /** The live compose pane is open (the tab owns it: on xl it renders in the aside). */
  compose: boolean;
  onCompose: () => void;
}): React.JSX.Element {
  const stack = app.name;
  const navigate = useNavigate();
  const { fitView } = useReactFlow();
  const wide = useMedia('(min-width: 768px)');
  const xl = useMedia('(min-width: 1280px)');
  const x = useCanvasExtras(stack, app.stat.services);
  const [connecting, setConnecting] = React.useState(false);
  const [cs, setCs] = React.useState<ConnectState>(NONE);
  const parts = React.useMemo(() => app.stat.services.filter((s) => !isManagedMember(s)), [app.stat.services]);
  const stores = x.extras?.data ?? [];
  const buckets = (x.lists.buckets?.buckets ?? []).filter((b) => !stores.some((s) => s.kind === 'object-storage' && s.name === b.name)).map((b) => bucketTarget(b, x.lists));

  React.useEffect(() => {
    const t = window.setTimeout(() => void fitView({ padding: 0.08, maxZoom: 1, duration: 250 }), 80);
    return () => window.clearTimeout(t);
  }, [compose, fitView]);

  const exit = React.useCallback(() => {
    setConnecting(false);
    setCs(NONE);
  }, []);

  const tap = (n: AnyCanvasNode): void => {
    if (connecting) {
      if (n.type === 'service' && (!cs.from || cs.from === n.id)) setCs({ from: n.id, to: null });
      else if (cs.from && (n.type === 'service' || n.type === 'data')) setCs({ ...cs, to: n.id });
      return;
    }
    if (n.type === 'service') onSelect(n.id);
    else if (n.type === 'domain') void navigate({ to: '/stacks/$name/network', params: { name: stack } });
    else if (n.type === 'dbCluster') void navigate({ to: '/stacks/$name/data', params: { name: stack } });
    else if (n.type === 'data' && n.data.spec.kind === 'object-storage') void navigate({ to: '/data/buckets/$name', params: { name: n.data.spec.name } });
    else if (n.type === 'data') void navigate({ to: '/stacks/$name/data', params: { name: stack }, hash: n.data.spec.kind === 'postgres' ? undefined : n.data.spec.kind });
  };

  const panel = connecting ? (
    <ConnectPanel stack={stack} parts={parts} stores={stores} buckets={buckets} endpoints={x.endpoints} state={cs} onChange={setCs} onExit={exit} />
  ) : null;

  return (
    <ConnectModeContext.Provider value={{ on: connecting, from: cs.from }}>
      <div className="flex flex-col gap-3 md:hidden">
        <div className="calm-card px-4 py-1">
          <PartsList services={app.stat.services} onOpen={onSelect} />
        </div>
        {wide ? null : panel ?? (
          <Button variant="outline" size="sm" className="self-start pointer-coarse:min-h-11" onClick={() => setConnecting(true)}>
            <SplineIcon className="size-3.5" />
            Connect a part to its data
          </Button>
        )}
      </div>
      <div className="calm-card relative hidden h-[min(620px,calc(100dvh-16rem))] min-h-[440px] overflow-hidden p-0 md:flex">
        {compose && !xl ? <ComposePane app={app} className="border-border w-[min(340px,42%)] shrink-0 border-r" /> : null}
        <div className="relative min-w-0 flex-1">
          <ServiceCanvas
            embedded
            stackFilter={stack}
            selectedId={part ?? ''}
            extras={x.extras}
            onNodeTap={tap}
            onConnectStart={(from) => setCs({ from, to: null })}
            onConnectDrag={(from, to) => setCs({ from, to })}
          >
            <CanvasTools
              stack={stack}
              connecting={connecting}
              onConnect={() => (connecting ? exit() : setConnecting(true))}
              composing={compose}
              onCompose={onCompose}
            />
          </ServiceCanvas>
          {wide && panel ? <div className="absolute top-3 left-3 z-10 w-[min(420px,calc(100%-1.5rem))]">{panel}</div> : null}
        </div>
      </div>
    </ConnectModeContext.Provider>
  );
}
