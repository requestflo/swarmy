import * as React from 'react';
import { StatusWord, Tech } from '@/components/calm';
import { bytes } from '@/lib/format';
import type { ServerGlance } from './use-servers-glance';

/** "Your server, at this depth": the first server in plain words, with its tech line at Controls. */
export function WelcomeServerCard({ server }: { server: ServerGlance }): React.JSX.Element {
  const { node, mem } = server;
  const online = node.status === 'online';
  const used = mem ?? server.cpu;
  return (
    <section aria-label="Your server" className="calm-card flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-[18px] font-bold">{node.name}</h2>
        <StatusWord tone={online ? 'ok' : 'bad'} className="ml-auto" />
      </div>
      <p className="text-muted-foreground text-[14px] leading-relaxed">
        A server{node.region ? ` in ${node.region}` : ''}.
        {used != null ? ` It is using ${used}% of its room.` : ''}
      </p>
      {used != null ? (
        <span aria-hidden className="bg-foreground/10 h-1.5 overflow-hidden rounded-full">
          <span className="bg-status-online block h-full rounded-full" style={{ width: `${Math.max(2, used)}%` }} />
        </span>
      ) : null}
      <Tech>
        {[node.hostname, node.publicIp, node.resources.cpus ? `${node.resources.cpus} vCPU` : null, node.resources.memBytes ? bytes(node.resources.memBytes) : null, node.role]
          .filter(Boolean)
          .join(' · ')}
      </Tech>
    </section>
  );
}
