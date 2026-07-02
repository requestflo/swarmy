import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@swarmy/ui';
import { NODE_STATUS_TONE, SERVICE_STATUS_TONE } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { useGo } from '@/lib/use-go';
import { useCommandPalette } from './command-palette-provider';
import { PRIMARY, SECTIONS, QUICK_ACTIONS, NAV_GROUP_ORDER } from '@/lib/destinations';

const SECTION_ORDER = NAV_GROUP_ORDER;

/** The ⌘K palette — primary navigator: planes, sections, quick actions, live entities. */
export function CommandPalette(): React.JSX.Element {
  const { open, setOpen } = useCommandPalette();
  const navigate = useNavigate();
  const go = useGo();
  const trpc = useTRPC();
  const services = useQuery({ ...trpc.services.list.queryOptions(), enabled: open });
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), enabled: open });

  const close = () => setOpen(false);
  const goTo = (to: string) => {
    close();
    go(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search services, nodes, or jump to anything…" />
      <CommandList>
        <CommandEmpty>No matches — try a service or node name.</CommandEmpty>

        <CommandGroup heading="Actions">
          {QUICK_ACTIONS.map((a) => (
            <CommandItem key={a.id} value={`${a.label} ${a.keywords ?? ''}`} onSelect={() => goTo(a.to)}>
              <a.icon className="text-primary" />
              {a.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Jump to">
          {PRIMARY.map((p) => (
            <CommandItem key={p.to} value={`${p.label} ${p.keywords ?? ''}`} onSelect={() => goTo(p.to)}>
              <p.icon />
              {p.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {SECTION_ORDER.map((group) => (
          <CommandGroup key={group} heading={group}>
            {SECTIONS.filter((s) => s.group === group).map((s) => (
              <CommandItem key={s.to} value={`${s.label} ${s.keywords ?? ''}`} onSelect={() => goTo(s.to)}>
                <s.icon />
                {s.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        {(services.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Services">
            {services.data?.slice(0, 8).map((svc) => (
              <CommandItem
                key={svc.id}
                value={`service ${svc.name} ${svc.image}`}
                onSelect={() => {
                  close();
                  void navigate({ to: '/services/$serviceId', params: { serviceId: svc.id } });
                }}
              >
                <span
                  className="size-2 rounded-full bg-current"
                  style={{ color: `var(--status-${SERVICE_STATUS_TONE[svc.status] ?? 'idle'})` }}
                />
                {svc.name}
                <span className="text-muted-foreground ml-auto truncate font-mono text-xs">{svc.image}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {(nodes.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Nodes">
            {nodes.data?.slice(0, 8).map((node) => (
              <CommandItem
                key={node.id}
                value={`node ${node.name} ${node.hostname}`}
                onSelect={() => {
                  close();
                  void navigate({ to: '/nodes/$nodeId', params: { nodeId: node.id } });
                }}
              >
                <span
                  className="size-2 rounded-full bg-current"
                  style={{ color: `var(--status-${NODE_STATUS_TONE[node.status] ?? 'idle'})` }}
                />
                {node.name}
                <span className="text-muted-foreground ml-auto truncate text-xs">{node.hostname}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
