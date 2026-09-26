import * as React from 'react';
import { LockIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { StatusWord } from '@/components/calm';
import { bytes } from '@/lib/format';
import type { ServerGlance } from './use-servers-glance';

const SMALL_APP = 256 * 1024 ** 2;

/** "room for ~12 small apps": free memory over 256 MB, rounded down. Null until memory is sampled. */
export function roomFor(server: ServerGlance): number | null {
  const total = server.node.resources.memBytes;
  if (!total || server.mem == null) return null;
  return Math.floor((total * (1 - server.mem / 100)) / SMALL_APP);
}

/** The dashboard is served over HTTPS right now (the page you are on). */
export function dashboardOnHttps(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:';
}

/**
 * The board's server card: name and Online, its public address, its size,
 * "Dashboard on HTTPS" when that's true, and how much room is left.
 */
export function WelcomeServerCard({
  server,
  dashboardHere,
  className,
}: {
  server: ServerGlance;
  /** This server serves the dashboard (the only one) and it's on HTTPS. */
  dashboardHere: boolean;
  className?: string;
}): React.JSX.Element {
  const { node, mem } = server;
  const online = node.status === 'online';
  const room = roomFor(server);
  const size = [node.resources.cpus ? `${node.resources.cpus} vCPU` : null, node.resources.memBytes ? bytes(node.resources.memBytes) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <section aria-label="Your server" className={cn('calm-card flex w-full flex-col gap-2.5 px-4 py-3.5', className)}>
      <div className="flex items-center gap-2">
        <h2 className="truncate text-[15px] font-semibold">{node.name}</h2>
        <StatusWord tone={online ? 'ok' : 'bad'} className="ml-auto" />
      </div>
      <p className="text-muted-foreground font-mono text-[12px] leading-relaxed">
        {node.publicIp ?? node.hostname}
        {size ? (
          <>
            <br />
            {size}
          </>
        ) : null}
      </p>
      {dashboardHere ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[12.5px]">
          <LockIcon aria-hidden className="text-tone-ok size-3.5" /> Dashboard on HTTPS
        </p>
      ) : null}
      {mem != null ? (
        <>
          <span aria-hidden className="bg-foreground/10 h-1.5 overflow-hidden rounded-full">
            <span className="bg-status-online block h-full rounded-full" style={{ width: `${Math.max(2, mem)}%` }} />
          </span>
          <p className="text-muted-foreground font-mono text-[11.5px]">
            {mem}% used{room != null ? ` · room for ~${room} small app${room === 1 ? '' : 's'}` : ''}
          </p>
        </>
      ) : online ? (
        <span className="shimmer-line h-3 w-3/4 rounded" aria-label="Measuring its room" />
      ) : null}
    </section>
  );
}
