import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ServerIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth, SectionLink, TONE_DOT } from '@/components/calm';
import { numberWord } from '@/components/apps/app-words';
import type { ServerGlance } from './use-servers-glance';

const HOT = 80;

function Bar({ label, value }: { label: string; value: number | null }): React.JSX.Element {
  const v = value ?? 0;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground w-8 shrink-0 font-mono text-[10.5px]">{label}</span>
      <span aria-hidden className="bg-foreground/10 h-1.5 min-w-6 flex-1 overflow-hidden rounded-full">
        <span
          className={cn('block h-full rounded-full', v >= HOT ? 'bg-status-warning' : 'bg-status-online')}
          style={{ width: `${v}%` }}
        />
      </span>
      <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-[11px]">
        {value == null ? '—' : `${value}%`}
      </span>
    </span>
  );
}

/** The servers in one line ("4 servers in 3 places, all online."), with per-server bars at Controls. */
export function ServersSection({ servers }: { servers: ServerGlance[] }): React.JSX.Element {
  const online = servers.filter((s) => s.node.status === 'online').length;
  const places = new Set(servers.map((s) => s.node.region).filter(Boolean)).size;
  const off = servers.find((s) => s.node.status === 'offline') ?? servers.find((s) => s.node.status !== 'online');
  const hot = [...servers].filter((s) => (s.disk ?? 0) >= HOT).sort((a, b) => (b.disk ?? 0) - (a.disk ?? 0))[0];
  const n = servers.length;
  const lead =
    online === n
      ? `${numberWord(n)} server${n === 1 ? '' : 's'}${places > 1 ? ` in ${places} places` : ''}, ${n === 1 ? 'online' : 'all online'}.`
      : `${online} of ${n} servers online.`;
  const detail = off
    ? `${off.node.name} is ${off.node.status === 'offline' ? 'offline' : off.node.status === 'draining' ? 'being emptied' : 'not ready yet'}.`
     : hot ? `${hot.node.name}’s disk is ${hot.disk}% full.` : servers.some((s) => s.disk != null) ? 'Every disk has room.' : '';

  return (
    <section aria-label="Servers" className="calm-card flex flex-col gap-3 px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <ServerIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <p className="min-w-0 flex-1 text-[14px]">
          <b className="font-semibold">{lead}</b> <span className="text-muted-foreground">{detail}</span>
        </p>
        <Link to="/nodes" className="pointer-coarse:py-3">
          <SectionLink>Servers →</SectionLink>
        </Link>
      </div>
      <Depth at="controls">
        <ul className="border-border flex flex-col border-t pt-1">
          {servers.map((s) => (
            <li key={s.node.id}>
              <Link
                to="/nodes/$nodeId"
                params={{ nodeId: s.node.id }}
                className="hover:bg-foreground/[0.025] flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 rounded-sm px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="flex w-40 shrink-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={cn('size-2 rounded-full', TONE_DOT[s.node.status === 'online' ? 'ok' : s.node.status === 'offline' ? 'bad' : 'warn'])}
                  />
                  <span className="truncate text-[13.5px] font-semibold">{s.node.name}</span>
                </span>
                <span className="text-muted-foreground w-24 shrink-0 truncate text-[12.5px]">{s.node.region ?? s.node.role}</span>
                <span className="grid min-w-[280px] flex-1 grid-cols-3 gap-5">
                  <Bar label="CPU" value={s.cpu} />
                  <Bar label="MEM" value={s.mem} />
                  <Bar label="DISK" value={s.disk} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Depth>
    </section>
  );
}
