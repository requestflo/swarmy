import * as React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Depth, Section, Tech } from '@/components/calm';
import { hostPort, listWords, typedName } from './connections-model';
import type { ServiceEndpoints, StackEndpoints } from './types';

/**
 * "Inside storefront · type the short name": one row per service with the
 * name its code types; "more names" opens the full name (which also works
 * from connected apps), the connected-app alias and, at Controls, the
 * per-copy `tasks.` name.
 */
export function InsideAppSection({ endpoints: e }: { endpoints: StackEndpoints }): React.JSX.Element {
  const [open, setOpen] = React.useState<string | null>(e.services[0]?.service ?? null);
  return (
    <Section title={`Inside ${e.stack}`} hint="type the short name" flush>
      {e.services.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13.5px]">{e.stack} runs no services of its own right now.</p>
      ) : (
        <div className="flex flex-col">
          {e.services.map((s) => (
            <AddressRow key={s.service} s={s} open={open === s.service} onToggle={() => setOpen(open === s.service ? null : s.service)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function AddressRow({ s, open, onToggle }: { s: ServiceEndpoints; open: boolean; onToggle: () => void }): React.JSX.Element {
  const id = React.useId();
  const typed = typedName(s);
  const full = s.names.find((n) => n.scope === 'app' && n.host === s.service);
  const tasks = s.names.find((n) => n.scope === 'app' && n.host.startsWith('tasks.'));
  const linked = s.names.find((n) => n.scope === 'connected');
  return (
    <div className="border-border border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="hover:bg-foreground/[0.025] focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-3 rounded-sm px-1 text-left text-[13.5px] outline-none focus-visible:ring-2"
      >
        <ChevronRightIcon aria-hidden className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="text-muted-foreground w-20 shrink-0 truncate sm:w-28">{s.short}</span>
        <span className="min-w-0 truncate font-mono font-semibold">{typed ? hostPort(typed.host, typed.port) : s.service}</span>
        <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]">more names</span>
      </button>
      {open ? (
        <div id={id} className="flex flex-col gap-1 pb-3 pl-7 text-[12.5px] leading-relaxed">
          {full ? <Name host={hostPort(full.host, full.port)} note="full name, also works from connected apps" /> : null}
          {linked ? <Name host={hostPort(linked.host, linked.port)} note={`from ${listWords(linked.from ?? [])}`} /> : null}
          {tasks ? (
            <Depth at="controls">
              <Name host={tasks.host} note={s.ports.length ? 'one IP per copy' : 'one IP per copy · no port swarmy knows of'} />
            </Depth>
          ) : null}
          {s.ports.length > 1 ? <Tech>ports {s.ports.join(', ')} · the names carry no port when there are several</Tech> : null}
        </div>
      ) : null}
    </div>
  );
}

function Name({ host, note }: { host: string; note: string }): React.JSX.Element {
  return (
    <span className="break-words">
      <span className="font-mono">{host}</span>
      <span className="text-muted-foreground"> · {note}</span>
    </span>
  );
}
