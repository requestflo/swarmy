import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import type { ServiceSummary } from '@swarmy/core';
import { Button, cn } from '@swarmy/ui';
import { Tech, TONE_DOT } from '@/components/calm';
import { techRoles } from '@/components/nodes/servers/server-words';
import type { ServerView } from './estate-model';
import { serverStory } from './focus-words';

interface Props {
  s: ServerView;
  /** Your services on this server (each one can be moved). */
  services: ServiceSummary[];
  onClose: () => void;
  className?: string;
}

/**
 * The server focus panel (board 22): click a server on the map and the
 * Right-now card gives way to it — its story in a sentence, live CPU and
 * memory, your apps on it, Open server, and Move… for each of your services
 * (the Servers page's move picker, `/nodes?move=<service>`).
 */
export function ServerFocus({ s, services, onClose, className }: Props): React.JSX.Element {
  const live = s.node.live;
  return (
    <section aria-label={`Server ${s.node.name}`} className={cn('calm-card flex flex-col gap-3 p-4', className)}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="calm-eyebrow">Server</span>
          <h2 className="font-display truncate text-[22px] font-bold tracking-[-0.01em]">{s.node.name}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close server" className="text-muted-foreground hover:text-foreground grid size-8 place-items-center rounded-lg pointer-coarse:size-11">
          <XIcon className="size-4" />
        </button>
      </div>
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">{serverStory(s)}</p>
      {live ? (
        <div className="flex flex-col gap-2.5">
          <Bar label="CPU" pct={live.cpuPercent} />
          <Bar label="Memory" pct={live.memPercent} />
        </div>
      ) : null}
      <Tech>
        {techRoles(s.node)} · {s.node.publicIp ?? 'no public ip'}
        {s.size ? ` · ${s.size}` : ''}
      </Tech>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/nodes/$nodeId" params={{ nodeId: s.node.id }}>Open server</Link>
        </Button>
      </div>
      {services.length ? (
        <div className="flex flex-col gap-1">
          <span className="calm-eyebrow">Move services</span>
          <ul className="flex flex-col gap-1">
            {services.map((svc) => (
              <li key={svc.id}>
                <Link
                  to="/nodes"
                  search={{ move: svc.id }}
                  className="bg-foreground/[0.04] hover:bg-foreground/[0.08] flex h-[30px] items-center gap-2 rounded-lg px-2.5 text-[13px] pointer-coarse:h-11"
                >
                  <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[svc.status === 'running' ? 'ok' : 'warn'])} />
                  <span className="truncate font-semibold">{svc.name}</span>
                  <span className="text-primary ml-auto shrink-0 font-mono text-[11.5px]">Move… →</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Bar({ label, pct }: { label: string; pct: number }): React.JSX.Element {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex flex-col gap-1">
      <span className="flex justify-between font-mono text-[11.5px]">
        <span className="text-muted-foreground">{label}</span>
        <span>{v}%</span>
      </span>
      <span className="bg-foreground/[0.08] block h-1.5 overflow-hidden rounded-full" role="meter" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <span className={cn('block h-full rounded-full', v >= 85 ? 'bg-status-warning' : 'bg-status-online')} style={{ width: `${v}%` }} />
      </span>
    </div>
  );
}
