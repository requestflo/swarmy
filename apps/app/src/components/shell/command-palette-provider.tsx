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

export function useCommandPalette(): CommandPaletteCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useCommandPalette must be used within CommandPaletteProvider');
  return ctx;
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
