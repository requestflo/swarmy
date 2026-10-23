import * as React from 'react';
import { Button } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { peerAddresses, type ManagedGroup } from './connections-model';
import { ConnectFlow, type ConfirmKind } from './connect-flow';
import { ConnectionsCode } from './connections-code';
import type { StackEndpoints } from './types';

/**
 * The aside: the Code view (at Code), who the app talks to (each with
 * Disconnect) and the "Connect to another app…" flow. Disconnect on a row
 * picks that app in the flow and asks to confirm there, so there is one
 * confirm and one place the change happens.
 */
export function LinksAside({
  endpoints: e,
  groups,
  apps,
  auditLine,
}: {
  endpoints: StackEndpoints;
  groups: ManagedGroup[];
  apps: string[];
  auditLine: string | null;
}): React.JSX.Element {
  // A connected app stays pickable even when it no longer runs (Disconnect cleans up this side).
  const others = [...new Set([...apps, ...e.connectedApps])].filter((a) => a !== e.stack).sort();
  const [peer, setPeer] = React.useState<string | undefined>(
    () => others.find((a) => !e.connectedApps.includes(a)) ?? others[0],
  );
  const [confirm, setConfirm] = React.useState<ConfirmKind | null>(null);
  const reach = peerAddresses(e);

  return (
    <aside aria-label="Connected apps" className="flex min-w-0 flex-col gap-4">
      <ConnectionsCode endpoints={e} peer={peer} />
      <Section title={`Who ${e.stack} talks to`} count={e.connectedApps.length} flush>
        {e.connectedApps.length === 0 ? (
          <p className="text-muted-foreground py-3 text-[13.5px]">No other app can reach {e.stack}’s services.</p>
        ) : (
          <div className="flex flex-col">
            {e.connectedApps.map((p) => (
              <div key={p} className="border-border flex min-h-14 items-center gap-3 border-b py-2 last:border-b-0">
                <span aria-hidden className="bg-status-online size-2 shrink-0 rounded-full" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13.5px] font-semibold">
                    {e.stack} ↔ {p}
                  </span>
                  <span className="text-muted-foreground font-mono text-[11px] break-words">
                    From {p}: {reach.slice(0, 2).join(', ')}
                    {reach.length > 2 ? ` +${reach.length - 2} more` : ''}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 pointer-coarse:min-h-11"
                  onClick={() => {
                    setPeer(p);
                    setConfirm('disconnect');
                  }}
                >
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>
      {others.length ? (
        <ConnectFlow
          endpoints={e}
          groups={groups}
          peers={others}
          peer={peer ?? others[0]!}
          onPeer={(p) => {
            setPeer(p);
            setConfirm(null);
          }}
          confirm={confirm}
          onConfirm={setConfirm}
          auditLine={auditLine}
        />
      ) : (
        <Section title="Connect to another app…">
          <p className="text-muted-foreground text-[13.5px]">{e.stack} is the only app here. Deploy another to connect them.</p>
        </Section>
      )}
    </aside>
  );
}
