import * as React from 'react';
import { CommandPalette } from './command-palette';

/**
 * Global ⌘K command palette state. The palette is the primary navigator in the
 * redesigned shell (there is no sidenav), so its open/close lives at the app
 * root and a single keydown listener owns the ⌘K / Ctrl-K shortcut.
 */
interface CommandPaletteCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const Ctx = React.createContext<CommandPaletteCtx | null>(null);

const NOOP: CommandPaletteCtx = { open: false, setOpen: () => undefined, toggle: () => undefined };

/** Safe everywhere: outside the provider (e.g. a full-screen route) it returns a no-op
 *  rather than crashing the page — the palette just isn't wired on that surface. */
export function useCommandPalette(): CommandPaletteCtx {
  return React.useContext(Ctx) ?? NOOP;
}

export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const toggle = React.useCallback(() => setOpen((o) => !o), []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const value = React.useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandPalette />
    </Ctx.Provider>
  );
}
