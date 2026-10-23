import * as React from 'react';
import type { NodeSummary } from '@swarmy/core';
import { Button, Switch } from '@swarmy/ui';
import { CalmRow, Depth, RowList, Section, Tech, type Tone } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { controllerPlacement } from './topology-model';
import { NatWarning } from './nat-warning';
import { useEdgeServers } from './use-edge-servers';

function rowSay(n: NodeSummary, nat: boolean): { tone: Tone; word: string; say: string } {
  if (n.ingress && nat) return { tone: 'warn', word: 'Needs you', say: 'Marked as an edge, but unreachable behind NAT' };
  if (n.ingress) return n.status === 'online' ? { tone: 'ok', word: 'Edge', say: 'Takes visits' } : { tone: 'warn', word: 'Edge', say: `Marked as an edge, but ${n.status}` };
  if (nat) return { tone: 'mesh', word: 'Behind NAT', say: 'Private network only' };
  return { tone: 'idle', word: 'Not an edge', say: 'Runs apps, takes no visits' };
}

/** Board 31's "Which servers are edges": one switch per server, the NAT warning, the one edge's pin at Controls. */
export function EdgeServersSection({
  perNode,
  geo,
  targetNodes,
  admin,
  onTunnel,
}: {
  perNode: boolean;
  geo: boolean;
  targetNodes: string[];
  admin: boolean | undefined;
  onTunnel: () => void;
}): React.JSX.Element {
  const s = useEdgeServers(targetNodes, perNode);
  const [asking, setAsking] = React.useState<NodeSummary | null>(null);
  const stuck = (s.nodes ?? []).filter((n) => n.ingress && s.natIds.has(n.id));
  const pin = targetNodes.length === 1 && !perNode && s.nodes ? controllerPlacement(s.nodes, targetNodes) : null;
  return (
    <Section title="Which servers are edges" hint={geo ? 'ports 80/443 + DNS :53' : 'ports 80/443'} flush>
      {s.nodes ? (
        <RowList label="Servers">
          {s.nodes.map((n) => {
            const nat = s.natIds.has(n.id);
            const say = rowSay(n, nat);
            const locked = !n.ingress ? false : s.lastEdge(n.id);
            return (
              <CalmRow
                key={n.id}
                tone={say.tone}
                name={n.name}
                sub={[n.region ?? 'no region', nat ? 'behind NAT' : null].filter(Boolean).join(' · ')}
                say={locked ? `${say.say} · the last edge` : say.say}
                tech={n.publicIp ?? 'no public IP'}
                word={say.word}
                trailing={
                  <Switch
                    aria-label={`Use ${n.name} as an edge`}
                    checked={!!n.ingress}
                    disabled={admin === false || s.pending || locked}
                    onCheckedChange={(on) => (on && nat ? setAsking(n) : s.toggle(n, on))}
                    className="shrink-0"
                  />
                }
              />
            );
          })}
        </RowList>
      ) : s.error ? (
        <ErrorState error={s.error} />
      ) : (
        <CardSkeleton className="border-0 p-0" />
      )}
      <div className="flex flex-col gap-2 pt-2 pb-2">
        {asking ? (
          <NatWarning
            name={asking.name}
            already={false}
            onTunnel={() => {
              setAsking(null);
              onTunnel();
            }}
            onAnyway={() => {
              s.toggle(asking, true);
              setAsking(null);
            }}
            onDismiss={() => setAsking(null)}
          />
        ) : null}
        {stuck.map((n) => (
          <NatWarning key={n.id} name={n.name} already onTunnel={onTunnel} />
        ))}
        {admin === false ? <p className="text-muted-foreground text-[12.5px]">Only an owner or admin can change which servers are edges.</p> : null}
        <Depth at="controls">
          <Tech>
            {perNode
              ? 'The switch sets swarmy.node.ingress + swarmy.node.outlet (off clears ingress). An edge runs Caddy host-mode on :80/:443 (a global service on the ingress label); with geo-DNS, swarmy-dns binds :53 where both are set.'
              : `The one edge runs ${pin ?? (s.nodes ? controllerPlacement(s.nodes, targetNodes) : 'on an edge server')} (replicated, 1 copy).`}
          </Tech>
          {pin && admin ? (
            <Button variant="ghost" size="sm" className="w-fit" onClick={s.clearPin} disabled={s.pending}>
              Clear the pin
            </Button>
          ) : null}
        </Depth>
      </div>
    </Section>
  );
}
