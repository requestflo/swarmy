import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView, useDepth } from '@/components/calm';
import { caddyfileOf } from '@/components/ingress/caddyfile-text';
import { useTRPC } from '@/integrations/trpc';
import { caddyTabs, edgeLabel, pickEdges, type EdgeRender } from './edge-caddy-model';

/**
 * The Caddyfile each edge runs (`ingress.edgeConfigs`: rendered on the
 * controller per edge, its own region first, secrets sealed), read-only, at
 * Code. Pick the edge and another to diff it against; with an address picked,
 * its own site block comes first. With no edge running it shows what swarmy
 * would write (`ingress.previewConfig`).
 */
export function NetworkCaddyCode({ selected, caddy }: { selected: string | null; caddy: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const atCode = useDepth().atLeast('code');
  const edges = useQuery({ ...trpc.ingress.edgeConfigs.queryOptions(), enabled: atCode && caddy });
  const list = (edges.data?.edges ?? []) as EdgeRender[];
  const noEdge = edges.isSuccess && list.length === 0;
  const preview = useQuery({ ...trpc.ingress.previewConfig.queryOptions({}), enabled: atCode && caddy && noEdge });
  const [on, setOn] = React.useState<string | null>(null);
  const [vs, setVs] = React.useState<string | null>(null);
  if (!caddy) return null;
  const { edge, other } = pickEdges(list, on, vs);
  const regional = !!edges.data?.regional;
  const tabs = caddyTabs({
    selected,
    edge,
    other,
    text: caddyfileOf(preview.data),
    pending: edges.isPending || (noEdge && preview.isPending),
    regional,
  });
  const toolbar =
    edge && other ? (
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <EdgeSelect label="Rendered on" value={edge.nodeId} edges={list} onChange={setOn} />
        <EdgeSelect label="Compare with" value={other.nodeId} edges={list.filter((e) => e.nodeId !== edge.nodeId)} onChange={setVs} />
      </div>
    ) : null;
  const differs = regional ? 'Each edge lists the app copies in its own region first, so the files differ by region. ' : list.length > 1 ? 'Every edge runs this same file. ' : '';
  return (
    <CodeView
      key={selected ?? '~'}
      title={edge ? `Rendered on ${edge.name}` : 'The Caddyfile swarmy writes'}
      tabs={tabs}
      source="readonly"
      toolbar={toolbar}
      note={`${differs}Read only. swarmy writes this from your domains; change them on this page or each app's Domains tab, not here.`}
    />
  );
}

function EdgeSelect({ label, value, edges, onChange }: { label: string; value: string; edges: EdgeRender[]; onChange: (id: string) => void }): React.JSX.Element {
  return (
    <label className="text-muted-foreground flex items-center gap-1.5">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-border bg-background text-foreground h-8 rounded-[8px] border px-2 font-mono text-[12px] pointer-coarse:min-h-11"
      >
        {edges.map((e) => (
          <option key={e.nodeId} value={e.nodeId}>{edgeLabel(e)}</option>
        ))}
      </select>
    </label>
  );
}
