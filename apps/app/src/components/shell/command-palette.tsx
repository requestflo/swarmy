import * as React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, Dialog, DialogContent, DialogTitle, cn } from '@swarmy/ui';
import { parseIntents, type Intent } from '@/lib/intents';
import { useCommandPalette } from './command-palette-provider';
import { IntentPreview } from './intent-preview';
import { PaletteFooter } from './palette-footer';
import { PaletteGroups } from './palette-groups';
import { PaletteTry } from './palette-try';
import { tryExamples, useIntentWorld } from './use-intent-world';

const key = (i: Intent) => `intent:${i.id}`;

/**
 * ⌘K — "Ask or jump" (the Command board). Plain intents ("deploy ghost as
 * blog", "undo analytics") become rows under Do it / Jump to, and the
 * highlighted one shows in the preview pane: what will happen, its one
 * button, and the API call behind it. ↵ on a Do it row moves to that button
 * (a second ↵ runs it); ⇥ opens the page to edit it by hand; ⌘↵ presses the
 * button straight away. Everything else is the jump list (PaletteGroups).
 */
function PaletteBody({ close }: { close: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const world = useIntentWorld();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState('');
  const ctaRef = React.useRef<HTMLButtonElement | null>(null);
  const intents = React.useMemo(() => parseIntents(query, world), [query, world]);
  const current = intents.find((i) => key(i) === active) ?? intents[0] ?? null;

  // Anything that navigates (a deploy handing off, an Open) closes the palette.
  const href = useRouterState({ select: (s) => s.location.href });
  const first = React.useRef(href);
  React.useEffect(() => {
    if (href !== first.current) close();
  }, [href, close]);

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
  const onKeys = (e: React.KeyboardEvent) => {
    if (!current) return;
    if (e.key === 'Tab' && !e.shiftKey && current.edit && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      goIntent({ ...current, action: current.edit });
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      ctaRef.current?.click();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onKeyDownCapture={onKeys}>
      <Command value={active} onValueChange={setActive} className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
        <div className="relative">
          <CommandInput className={current ? 'pr-44' : 'pr-8'} value={query} onValueChange={setQuery} placeholder="Ask or jump… “deploy ghost as blog”, an app, a server, a page" />
          {current ? (
            <span className="border-border text-foreground/80 absolute top-2 right-11 rounded-full border px-2.5 py-0.5 font-mono text-[11px]">
              Intent · {current.verb}
            </span>
          ) : null}
        </div>
        <PaletteTry examples={tryExamples(world)} query={query} onPick={setQuery} />
        <div className={cn('grid grid-cols-[minmax(0,1fr)]', current && 'md:grid-cols-[minmax(0,1fr)_340px]')}>
          <CommandList className="max-h-[min(440px,55vh)]">
            {intents.length ? null : <CommandEmpty>Nothing matches. Try an app or server name, “deploy ghost” or “undo …”.</CommandEmpty>}
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
        <PaletteFooter canEdit={!!current?.edit} canRun={!!current} />
      </Command>
    </div>
  );
}

export function CommandPalette(): React.JSX.Element {
  const { open, setOpen } = useCommandPalette();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[min(58rem,calc(100vw-2rem))] grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Ask or jump</DialogTitle>
        {open ? <PaletteBody close={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
