import * as React from 'react';
import { cn } from '@swarmy/ui';
import { useDepth } from '@/components/calm';
import { SIGN_IN_PATH, type Simulation } from './simulate';
import type { AppAccessPerson, AppAccessRoute } from './types';

interface Props {
  stack: string;
  route: AppAccessRoute;
  person: AppAccessPerson | null;
  sim: Simulation;
}

/**
 * The four stops of one simulated request: Visitor → the front door (Caddy,
 * TLS) → the sign-in check (forward_auth → swarmy, only on protected
 * addresses) → what answers. Plain words at Summary; the edge's own terms
 * from Controls up.
 */
export function RequestFlow({ stack, route, person, sim }: Props): React.JSX.Element {
  const tech = useDepth().atLeast('controls');
  const service = route.serviceName.replace(`${stack}_`, '');
  const end =
    sim.outcome === 'signin'
      ? { name: 'Sign-in page', sub: tech ? `302 → swarmy ${SIGN_IN_PATH}` : 'swarmy asks who they are', tone: 'bad' as const }
      : sim.outcome === 'denied'
        ? { name: 'Turned away', sub: tech ? '403 · no access to this app' : 'the app never sees it', tone: 'bad' as const }
        : { name: `${stack} / ${service}`, sub: tech ? `${route.serviceName} · ${route.path}` : `gets ${route.path}`, tone: 'ok' as const };
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="What happens to this request">
        <Stop title="Visitor" sub={person?.email ?? (person ? (person.name ?? 'member') : 'not signed in')} />
        <Dashes />
        <Stop title={tech ? 'Edge · Caddy' : 'Front door'} sub={tech ? `TLS · ${route.host}` : `HTTPS · ${route.host}`} />
        <Dashes muted={!sim.checked} />
        <Stop
          title="Sign-in check"
          sub={sim.checked ? (tech ? 'forward_auth → swarmy' : 'swarmy checks who they are') : 'skipped · this address is public'}
          className={sim.checked ? 'border-tone-mesh' : 'opacity-50'}
        />
        <Dashes muted={!sim.reaches} />
        <Stop title={end.name} sub={end.sub} className={end.tone === 'ok' ? 'border-tone-ok' : 'border-tone-bad'} />
      </ol>
      <p className="text-muted-foreground text-[13px]" aria-live="polite">
        {sim.caption}
      </p>
    </div>
  );
}

function Dashes({ muted }: { muted?: boolean }): React.JSX.Element {
  return <li aria-hidden className={cn('flow-dashes hidden sm:block', muted && 'flow-dashes-muted')} />;
}

function Stop({ title, sub, className }: { title: string; sub: string; className?: string }): React.JSX.Element {
  return (
    <li className={cn('flex min-w-0 flex-col gap-0.5 rounded-[10px] border px-3 py-1.5', className)}>
      <span className="truncate text-[12.5px] font-semibold">{title}</span>
      <span className="text-muted-foreground truncate font-mono text-[11px]">{sub}</span>
    </li>
  );
}
