import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { linkErrorWords, type ManagedGroup } from './connections-model';
import { LinkPreview } from './link-preview';
import { ConfirmLink } from './confirm-link';
import type { StackEndpoints } from './types';

export type ConfirmKind = 'connect' | 'disconnect';

/**
 * "Connect to another app…": pick the other app, read what connecting does,
 * confirm. `stacks.connect` / `stacks.disconnect` need deploy permission on
 * BOTH apps and are audited (`stack.link.add` / `stack.link.remove`); the
 * newest such row for this app is the line under the button.
 */
export function ConnectFlow({
  endpoints: e,
  groups,
  peers,
  peer,
  onPeer,
  confirm,
  onConfirm,
  auditLine,
}: {
  endpoints: StackEndpoints;
  groups: ManagedGroup[];
  peers: string[];
  peer: string;
  onPeer: (p: string) => void;
  confirm: ConfirmKind | null;
  onConfirm: (c: ConfirmKind | null) => void;
  auditLine: string | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const theirs = useQuery({ ...trpc.stacks.endpoints.queryOptions({ stack: peer }), retry: false });
  const [result, setResult] = React.useState<string | null>(null);
  const done = (kind: ConfirmKind) => (r: { services: string[] }) => {
    const n = r.services.length;
    setResult(
      n === 0
        ? kind === 'connect' ? 'Already connected. Nothing restarted.' : 'Already apart. Nothing restarted.'
        : `${kind === 'connect' ? 'Connected' : 'Disconnected'} · ${n} service${n === 1 ? '' : 's'} restarting, rolling.`,
    );
    onConfirm(null);
    void qc.invalidateQueries();
  };
  const connect = useMutation(trpc.stacks.connect.mutationOptions({ onSuccess: done('connect') }));
  const disconnect = useMutation(trpc.stacks.disconnect.mutationOptions({ onSuccess: done('disconnect') }));
  const busy = connect.isPending || disconnect.isPending;
  const error = connect.error ?? disconnect.error;
  const connected = e.connectedApps.includes(peer);
  const pick = (p: string): void => {
    onPeer(p);
    setResult(null);
    connect.reset();
    disconnect.reset();
  };

  return (
    <Section title="Connect to another app…">
      <div role="group" aria-label="The other app" className="flex flex-wrap gap-1.5">
        {peers.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={p === peer}
            onClick={() => pick(p)}
            className={cn(
              'border-border h-8 rounded-[9px] border px-2.5 font-mono text-xs font-semibold pointer-coarse:min-h-11',
              p === peer ? 'bg-surface-2 text-foreground dark:bg-accent border-foreground/25' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {p}
            {e.connectedApps.includes(p) ? (
              <>
                <span aria-hidden className="text-tone-ok"> ✓</span>
                <span className="sr-only"> (connected)</span>
              </>
            ) : null}
          </button>
        ))}
      </div>
      <LinkPreview endpoints={e} groups={groups} peer={peer} theirs={theirs.data} theirsFailed={theirs.isError} connected={connected} />
      {confirm ? (
        <ConfirmLink
          kind={confirm}
          app={e.stack}
          peer={peer}
          total={theirs.data ? e.services.length + theirs.data.services.length : null}
          busy={busy}
          onYes={() => (confirm === 'connect' ? connect : disconnect).mutate({ stack: e.stack, peer })}
          onNo={() => onConfirm(null)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button variant={connected ? 'outline' : 'default'} onClick={() => onConfirm(connected ? 'disconnect' : 'connect')}>
            {connected ? 'Disconnect' : 'Connect'}
          </Button>
          <span className="text-muted-foreground font-mono text-[11px]">
            {connected ? 'connected · same organisation · audited' : 'needs deploy permission on both apps'}
          </span>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-tone-bad text-[12.5px]">
          {linkErrorWords(error, e.stack, peer)}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="text-tone-ok text-[12.5px]">
          {result}
        </p>
      ) : null}
      {auditLine ? (
        <p className="text-muted-foreground flex items-start gap-2 font-mono text-[11px] break-words">
          <CheckIcon aria-hidden className="text-tone-ok mt-px size-3 shrink-0" />
          {auditLine}
        </p>
      ) : null}
    </Section>
  );
}
