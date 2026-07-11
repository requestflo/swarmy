import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, RotateCwIcon, TerminalIcon, ZapIcon } from 'lucide-react';
import type { ServiceDetail } from '@swarmy/core';
import { Button, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ServiceHeroProps {
  service: ServiceDetail;
  deploying: boolean;
  asleep: boolean;
  /** Overlay mode: the canvas sits right behind, so no breadcrumb + tighter type. */
  compact?: boolean;
}

/** The status statement — the page tells you how the service is doing, in words. */
function statusPhrase(s: ServiceDetail, deploying: boolean, asleep: boolean): React.ReactNode {
  if (asleep) return <>is <em>asleep</em>.</>;
  if (deploying || s.status === 'deploying') return <>is <em>converging</em>.</>;
  switch (s.status) {
    case 'running':
      return <>is <em>live</em>.</>;
    case 'degraded':
      return <>needs <em>you</em>.</>;
    case 'failed':
      return <>is <em>down</em>.</>;
    case 'removing':
      return <>is <em>winding down</em>.</>;
    case 'stopped':
      return <>is <em>stopped</em>.</>;
    default:
      return <>is <em>pending</em>.</>;
  }
}

/**
 * Hero for the service page: breadcrumb back to the stack, a headline that
 * speaks the status, the image in mono, and the two quiet actions. The one
 * coral CTA is contextual — "Wake it" only when the service is asleep.
 */
export function ServiceHero({ service, deploying, asleep, compact }: ServiceHeroProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const restart = useMutation(
    trpc.services.restart.mutationOptions({
      onSuccess: () => toast.success('Restart queued'),
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
    <div>
      {compact ? null : service.stackId ? (
        <Link
          to="/stacks/$name"
          params={{ name: service.stackId }}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
        >
          <ArrowLeftIcon className="size-4" /> {service.stackId}
        </Link>
      ) : (
        <Link
          to="/services"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm font-medium transition-colors"
        >
          <ArrowLeftIcon className="size-4" /> Services
        </Link>
      )}

      <div className={cn('flex flex-wrap items-end justify-between gap-4', compact ? '' : 'mt-3')}>
        <div className="min-w-0">
          <span className="eyebrow">Service{service.stackId ? ` · ${service.stackId}` : ''}</span>
          <h1 className={cn('headline mt-3 break-words', compact ? 'text-2xl sm:text-3xl' : 'text-[2rem] sm:text-4xl')}>
            {service.name} {statusPhrase(service, deploying, asleep)}
          </h1>
          <p className="mono-data text-muted-foreground mt-2 text-sm">{service.image}</p>
        </div>
        <div className="flex items-center gap-2">
          {asleep ? (
            <Button className="font-bold" disabled={wake.isPending} onClick={() => wake.mutate({ id: service.id })}>
              <ZapIcon className="size-4" /> Wake it
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="rounded-full font-bold"
            disabled={restart.isPending}
            onClick={() => restart.mutate({ id: service.id })}
          >
            <RotateCwIcon className="size-4" /> Restart
          </Button>
          <Button asChild variant="outline" className="rounded-full font-bold">
            <Link to="/services/$serviceId/terminal" params={{ serviceId: service.id }}>
              <TerminalIcon className="size-4" /> Terminal
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
