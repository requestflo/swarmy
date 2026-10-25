import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon } from 'lucide-react';
import { Button, cn, toast } from '@swarmy/ui';
import { TONE_TEXT } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

/** 5_800 → "6 s"; 75_000 → "1 m 15 s". */
export function backInWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`;
}

interface Props {
  nodeId: string;
  name: string;
  /** The agent advertised `restartAgent`; older agents get no button. */
  available: boolean | undefined;
  online: boolean;
}

/**
 * Board 11's "Restart agent": the agent answers, exits cleanly and what runs
 * it (systemd or Docker) starts it again; the call resolves once it checks
 * back in, and the line beside the button says how long that took. Apps on
 * the server keep running throughout.
 */
export function RestartAgentButton({ nodeId, name, available, online }: Props): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [said, setSaid] = React.useState<{ ok: boolean; text: string } | null>(null);
  const restart = useMutation(
    trpc.nodes.restartAgent.mutationOptions({
      onMutate: () => setSaid(null),
      onSuccess: (r) => {
        setSaid(
          r.backInMs !== null
            ? { ok: true, text: `Back in ${backInWords(r.backInMs)}` }
            : { ok: false, text: `Restarted; ${name} hasn’t checked back in yet` },
        );
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!available) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        disabled={!online || restart.isPending}
        title={online ? `Restart the swarmy agent on ${name}; apps keep running` : `${name} is offline`}
        onClick={() => restart.mutate({ id: nodeId })}
      >
        <RotateCwIcon className={cn('size-4', restart.isPending && 'motion-safe:animate-spin')} />
        {restart.isPending ? 'Restarting agent…' : 'Restart agent'}
      </Button>
      {said ? (
        <span role="status" className={cn('font-mono text-[12px]', TONE_TEXT[said.ok ? 'ok' : 'warn'])}>
          {said.text}
        </span>
      ) : null}
    </span>
  );
}
