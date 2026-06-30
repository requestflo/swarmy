import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { GlobeIcon, LayoutGridIcon, Loader2Icon, ServerIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';
import { ClusterHero } from '@/components/infra/cluster-hero';
import { InfraCanvas } from '@/components/infrastructure/infra-canvas';

const RegionGlobe = React.lazy(
  () =>
    // region-globe.tsx is delivered by the parallel globe agent (default export, no required props, self-fetching).
    // @ts-ignore module resolves at integration time; the globe agent owns this file.
    import('@/components/infrastructure/region-globe') as Promise<{
      default: React.ComponentType;
    }>,
);

/**
 * The Infrastructure plane — the cluster. ClusterHero KPIs on top, then a live
 * topology you can read two ways: a React Flow Canvas of node cards (the swarm as
 * a graph, dragging persists per-node layout) or a Globe view of regions.
 */
export const Route = createFileRoute('/_authed/nodes/')({
  component: InfrastructurePlane,
});

type InfraView = 'canvas' | 'globe';

function InfrastructurePlane(): React.JSX.Element {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [view, setView] = React.useState<InfraView>('canvas');
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5_000 });
  const online = (nodes.data ?? []).filter((n) => n.status === 'online').length;
  const total = nodes.data?.length ?? 0;
  const allGreen = total > 0 && online === total;

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Infrastructure"
        title={
          allGreen ? (
            <>
              Your cluster's <em>healthy</em>.
            </>
          ) : (
            <>
              <CountUp value={online} /> of {total} nodes <em>online</em>.
            </>
          )
        }
        description="Every machine in your swarm — capacity, health, and what runs where."
        actions={
          <Button onClick={() => navigate({ to: '/nodes/new' })}>
            <ServerIcon className="size-4" /> Add a node
          </Button>
        }
      />

      <ClusterHero />

      <div className="mt-8 flex items-center justify-between gap-3">
        <h2 className="mono-label !mb-0">{view === 'canvas' ? 'Topology' : 'Regions'}</h2>
        <ViewToggle view={view} onChange={setView} />
      </div>

      <div className="mt-4">
        {view === 'canvas' ? (
          <InfraCanvas />
        ) : (
          <React.Suspense fallback={<GlobeFallback />}>
            <RegionGlobe />
          </React.Suspense>
        )}
      </div>
    </div>
  );
}

/** Segmented Canvas | Globe switch for the Infrastructure plane. */
function ViewToggle({
  view,
  onChange,
}: {
  view: InfraView;
  onChange: (v: InfraView) => void;
}): React.JSX.Element {
  return (
    <div className="bg-muted/60 inline-flex items-center gap-1 rounded-full p-1">
      <ToggleButton
        active={view === 'canvas'}
        onClick={() => onChange('canvas')}
        icon={<LayoutGridIcon className="size-3.5" />}
        label="Canvas"
      />
      <ToggleButton
        active={view === 'globe'}
        onClick={() => onChange('globe')}
        icon={<GlobeIcon className="size-3.5" />}
        label="Globe"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function GlobeFallback(): React.JSX.Element {
  return (
    <div className="border-border/60 bg-card/30 text-muted-foreground flex h-[clamp(520px,68vh,860px)] w-full items-center justify-center rounded-3xl border">
      <Loader2Icon className="size-5 animate-spin" />
    </div>
  );
}
