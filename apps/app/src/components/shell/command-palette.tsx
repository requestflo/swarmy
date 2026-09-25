import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, Dialog, DialogContent, DialogTitle, cn } from '@swarmy/ui';
import { useApps } from '@/components/apps/use-apps';
import { parseIntents, type Intent, type IntentWorld } from '@/lib/intents';
import { useCommandPalette } from './command-palette-provider';
import { IntentPreview } from './intent-preview';
import { PaletteGroups } from './palette-groups';

/** What the intents can name: apps (with their addresses) and their parts. */
function useIntentWorld(): IntentWorld {
  const a = useApps();
  return React.useMemo(() => {
    const all = [...a.apps, ...a.platform];
    return {
      apps: all.map((x) => ({ name: x.name, hosts: x.hosts })),
      parts: all.flatMap((x) =>
        x.stat.services.map((s) => ({ id: s.id, name: s.name.replace(`${x.name}_`, ''), app: x.name, desired: s.replicas.desired })),
      ),
    };
  }, [a.apps, a.platform]);
}

const key = (i: Intent) => `intent:${i.id}`;

/**
 * ⌘K — "Ask or jump" (the Command board). Plain intents ("undo analytics",
 * "add a domain to shop") become rows under Do it / Jump to, and the
 * highlighted one shows in the preview pane: what will happen, its one
 * button, and the API call behind it. Enter on a Do it row moves to that
 * button, so nothing runs without a second Enter. Everything else is the
 * jump list (PaletteGroups).
 */
function PaletteBody({ close }: { close: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const world = useIntentWorld();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState('');
  const ctaRef = React.useRef<HTMLButtonElement | null>(null);
  const intents = React.useMemo(() => parseIntents(query, world), [query, world]);
  const current = intents.find((i) => key(i) === active) ?? intents[0] ?? null;
  const app = world.apps[0]?.name;
  const part = world.parts.find((p) => p.app === app)?.name;
  const examples = app ? [`undo ${app}`, `add a domain to ${app}`, part ? `restart ${part}` : null, `why is ${app} slow`].filter((x): x is string => !!x) : [];

  const goIntent = (i: Intent) => {
    if (i.action.kind !== 'go') return;
    close();
    void navigate({ to: i.action.to, params: i.action.params as never, search: i.action.search as never });
  };
  const select = (i: Intent) => {
    if (i.action.kind === 'go') return goIntent(i);
    setActive(key(i));
    requestAnimationFrame(() => ctaRef.current?.focus());
  };

  return (
    <Command value={active} onValueChange={setActive} className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
      <CommandInput className="pr-8" value={query} onValueChange={setQuery} placeholder="Ask or jump… “undo storefront”, an app, a server, a page" />
      <div className="text-muted-foreground flex min-h-9 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[12px]">
        {current ? (
          <span className="calm-eyebrow text-primary">Intent · {current.verb}</span>
        ) : (
          <>
            <span className="calm-eyebrow">Try</span>
            {examples.map((x) => (
              <button key={x} type="button" onClick={() => setQuery(x)} className="border-border hover:text-foreground hover:border-primary/60 rounded-full border px-2.5 py-0.5 pointer-coarse:min-h-11">
                {x}
              </button>
            ))}
          </>
        )}
      </div>
      <div className={cn('grid grid-cols-[minmax(0,1fr)]', current && 'md:grid-cols-[minmax(0,1fr)_320px]')}>
        <CommandList className="max-h-[min(420px,50vh)]">
          {intents.length ? null : <CommandEmpty>Nothing matches. Try an app or server name, or “undo …”.</CommandEmpty>}
          {(['Do it', 'Jump to'] as const).map((g) =>
            intents.some((i) => i.group === g) ? (
              <CommandGroup key={g} heading={g} forceMount>
                {intents.filter((i) => i.group === g).map((i) => (
                  <CommandItem key={i.id} value={key(i)} keywords={[query]} forceMount onSelect={() => select(i)}>
                    <span aria-hidden className={cn('size-2.5 shrink-0 border-2', g === 'Do it' ? 'border-primary bg-primary rounded-full' : 'border-muted-foreground rounded-[2px]')} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{i.title}</span>
                      <span className="text-muted-foreground truncate text-[12px]">{i.sub}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null,
          )}
          {intents.length ? <CommandSeparator /> : null}
          <PaletteGroups apps={world.apps.map((a) => a.name)} close={close} />
        </CommandList>
        {current ? (
          // Enter/Space on the preview's button is the button's own, not cmdk's "select the row".
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions
          <div
            className="border-border bg-surface-2/40 min-w-0 border-t md:border-t-0 md:border-l"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
            }}
          >
            <IntentPreview key={current.id} intent={current} ctaRef={ctaRef} onGo={goIntent} onDone={close} />
          </div>
        ) : null}
      </div>
      <div className="text-muted-foreground hidden gap-4 border-t px-3 py-2 font-mono text-[11px] sm:flex">
        <span>↑↓ move</span>
        <span>↵ preview, then ↵ to run</span>
        <span>esc close</span>
        <span className="ml-auto">every action is checked against your role and logged</span>
      </div>
    </Command>
  );
}

export function CommandPalette(): React.JSX.Element {
  const { open, setOpen } = useCommandPalette();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[min(56rem,calc(100vw-2rem))] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Ask or jump</DialogTitle>
        {open ? <PaletteBody close={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
