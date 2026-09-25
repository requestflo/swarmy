import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon, TerminalIcon, ZapIcon } from 'lucide-react';
import type { ServiceDetail } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { Say, SayHeader, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

interface ServiceHeroProps {
  service: ServiceDetail;
  deploying: boolean;
  asleep: boolean;
  /** Overlay mode: the canvas sits right behind, so a tighter header. */
  compact?: boolean;
}

const copies = (n: number): string => `${n} cop${n === 1 ? 'y' : 'ies'}`;

/** The status as a sentence: "checkout is running 1 of 2 copies." */
function statusSentence(s: ServiceDetail, deploying: boolean, asleep: boolean): React.ReactNode {
  const { running, desired } = s.replicas;
  if (asleep) return <>{s.name} is asleep. <em>It wakes on the next visit.</em></>;
  if (s.status === 'degraded') return <>{s.name} is <Say tone="warn">running {running} of {copies(desired)}.</Say></>;
  if (deploying || s.status === 'deploying' || s.status === 'pending')
    return <>{s.name} is <Say tone="info">rolling out</Say>, <em>{running} of {copies(desired)} ready.</em></>;
  switch (s.status) {
    case 'running':
      return <>{s.name} is online, <em>running {copies(running)}.</em></>;
    case 'failed':
      return <>{s.name} is <Say tone="bad">down.</Say> <em>No copy is running.</em></>;
    case 'removing':
      return <>{s.name} is <em>being removed.</em></>;
    default:
      return <>{s.name} is stopped. <em>It has no copies.</em></>;
  }
}

/**
 * The service's sentence header (board ServiceSheet): what it is doing, the
 * image it runs, and two quiet actions. The coral one is contextual: "Wake it"
 * only when it sleeps (a short service gets its coral in the next-action card).
 */
export function ServiceHero({ service, deploying, asleep, compact }: ServiceHeroProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const restart = useMutation(
    trpc.services.restart.mutationOptions({
      onSuccess: () => toast.success('Restarting, one copy at a time'),
      onError: (e) => toast.error(e.message),
    }),
  );
  const wake = useMutation(
    trpc.services.wake.mutationOptions({
      onSuccess: () => {
        toast.success('Waking it up');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <SayHeader
      size={compact ? 'md' : 'lg'}
      eyebrow={`Service${service.stackId ? ` · ${service.stackId}` : ''}`}
      title={statusSentence(service, deploying, asleep)}
      lede={
        <>
          <span className="font-mono text-[13px] break-all">{service.image}</span>
          {service.lastError && (service.status === 'failed' || service.status === 'degraded') ? (
            <span className="text-tone-bad mt-1 block text-[13.5px] break-words">Last error: {service.lastError}</span>
          ) : null}
          <span className="mt-1 block">
            <Tech>
              {service.swarmServiceId ?? service.id} · {service.networks.join(', ') || 'no networks'}
            </Tech>
          </span>
        </>
      }
      actions={
        <>
          {asleep ? (
            <Button disabled={wake.isPending} onClick={() => wake.mutate({ id: service.id })}>
              <ZapIcon className="size-4" /> Wake it
            </Button>
          ) : null}
          <Button variant="outline" className="pointer-coarse:min-h-11" disabled={restart.isPending} onClick={() => restart.mutate({ id: service.id })}>
            <RotateCwIcon className="size-4" /> Restart
          </Button>
          <Button asChild variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/services/$serviceId/terminal" params={{ serviceId: service.id }}>
              <TerminalIcon className="size-4" /> Terminal
            </Link>
          </Button>
        </>
      }
    />
  );
}
