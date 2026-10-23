import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { DataNodeSpec } from '../data-nodes';
import { planConnect } from './connect-plan';
import type { ConnectFrom } from './use-connect';

/** "connect another app →": apps reach each other only once connected (Network › Connections). */
export function OtherAppLink({ stack }: { stack: string }): React.JSX.Element {
  return (
    <Link to="/network/connections" search={{ app: stack }} className="text-primary ml-auto font-mono text-[11px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
      connect another app →
    </Link>
  );
}

/**
 * "Connect worker → cache": what swarmy will add and that the part restarts,
 * then Connect (the store's own attach call) or Cancel / Esc.
 */
export function ConnectPreview({
  stack,
  from,
  to,
  stores,
  pending,
  onConnect,
  onCancel,
  className,
}: {
  stack: string;
  from: ConnectFrom;
  to: DataNodeSpec;
  stores: readonly DataNodeSpec[];
  pending: boolean;
  onConnect: () => void;
  onCancel: () => void;
  className?: string;
}): React.JSX.Element {
  const plan = planConnect(from.short, to, stores);
  const titleId = React.useId();
  const go = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => go.current?.focus({ preventScroll: true }), [to.id, from.id]);

  return (
    <div role="group" aria-labelledby={titleId} className={cn('calm-next flex flex-col gap-2.5 px-4 py-3.5', className)}>
      <h3 id={titleId} className="flex items-center gap-2 text-[14px] font-semibold">
        <span aria-hidden className="bg-primary size-2 shrink-0 rounded-full motion-safe:animate-pulse" />
        Connect {plan.title}
      </h3>
      {plan.blocked ? (
        <p className="text-tone-warn text-[13px] leading-relaxed">{plan.blocked}</p>
      ) : (
        <>
          <p className="text-muted-foreground text-[13px] leading-relaxed">{plan.say}</p>
          <pre className="calm-code overflow-x-auto px-3 py-2.5 text-[11.5px]">
            {plan.lines.map((l) => (
              <React.Fragment key={l.key}>
                + {l.key}={l.value}
                {l.note ? <span className="opacity-60">{`  # ${l.note}`}</span> : null}
                {'\n'}
              </React.Fragment>
            ))}
          </pre>
          <p className="text-muted-foreground text-[12px]">Connections add their own variables. You never paste a database password.</p>
          <Tech>{plan.tech}</Tech>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {plan.blocked ? null : (
          <Button ref={go} size="sm" disabled={pending} onClick={onConnect}>
            {pending ? 'Connecting…' : 'Connect'}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>
          {plan.blocked ? 'Close' : 'Cancel'}
        </Button>
        <OtherAppLink stack={stack} />
      </div>
    </div>
  );
}
