import * as React from 'react';

export interface MultiSelect {
  picking: boolean;
  picked: Set<string>;
  /** Start (seeded with `seed`, the inspected server) or stop selecting. */
  toggle: (seed?: string | null) => void;
  flip: (id: string) => void;
  done: () => void;
}

/** "x" selects several servers (board 11); "x" or Esc again stops. Typing in a field never triggers it. */
export function useMultiSelect(seed: string | null): MultiSelect {
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  const done = React.useCallback(() => {
    setPicking(false);
    setPicked(new Set());
  }, []);
  const toggle = React.useCallback(
    (from?: string | null) => {
      if (picking) return done();
      setPicked(new Set(from ? [from] : []));
      setPicking(true);
    },
    [picking, done],
  );
  const flip = React.useCallback((id: string) => {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        toggle(seed);
      } else if (e.key === 'Escape' && picking) done();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, seed, picking, done]);

  return { picking, picked, toggle, flip, done };
}
