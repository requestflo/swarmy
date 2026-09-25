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
import { computeStackStats } from '@/components/canvas/stack-aggregates';
import { useCommandPalette } from './command-palette-provider';
import { PRIMARY, SECTIONS, QUICK_ACTIONS, NAV_GROUP_ORDER } from '@/lib/destinations';
import { DEPTHS, DEPTH_LABEL, usePageDepth, useDepthDefault } from '@/components/calm/depth';

const SECTION_ORDER = NAV_GROUP_ORDER;

/**
 * ⌘K — "Ask or jump": actions, the seven rows and their pages, live apps /
 * services / servers, and the depth for this page or by default.
 */
export function CommandPalette(): React.JSX.Element {
  const { open, setOpen } = useCommandPalette();
  const navigate = useNavigate();
  const go = useGo();
  const trpc = useTRPC();
  const services = useQuery({ ...trpc.services.list.queryOptions(), enabled: open });
  const nodes = useQuery({ ...trpc.nodes.list.queryOptions(), enabled: open });
  const page = usePageDepth();
  const def = useDepthDefault();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), enabled: open });
  const stacks = React.useMemo(
    () => (inventory.data ? computeStackStats(inventory.data).map((s) => s.name) : []),
    [inventory.data],
  );

  const close = () => setOpen(false);
  const goTo = (to: string) => {
    close();
    go(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Ask or jump… an app, a server, a page, or “deploy”" />
      <CommandList>
        <CommandEmpty>Nothing matches. Try an app or server name.</CommandEmpty>

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

        {stacks.length > 0 && (
          <CommandGroup heading="Apps">
            {stacks.slice(0, 8).map((name) => (
              <CommandItem
                key={name}
                value={`app ${name}`}
                onSelect={() => {
                  close();
                  void navigate({ to: '/stacks/$name', params: { name } });
                }}
              >
                {name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

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
          <CommandGroup heading="Servers">
            {nodes.data?.slice(0, 8).map((node) => (
              <CommandItem
                key={node.id}
                value={`server node ${node.name} ${node.hostname}`}
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
        <CommandSeparator />
        <CommandGroup heading="Show me">
          {DEPTHS.map((d) => (
            <CommandItem key={`page-${d}`} value={`show ${d} depth this page detail`} onSelect={() => { page.setDepth(d); close(); }}>
              {DEPTH_LABEL[d]} on this page
              {page.depth === d ? <span className="text-muted-foreground ml-auto text-xs">now</span> : null}
            </CommandItem>
          ))}
          {DEPTHS.map((d) => (
            <CommandItem key={`default-${d}`} value={`default ${d} depth always`} onSelect={() => { def.set(d); close(); }}>
              {DEPTH_LABEL[d]} by default
              {def.value === d ? <span className="text-muted-foreground ml-auto text-xs">your default</span> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
