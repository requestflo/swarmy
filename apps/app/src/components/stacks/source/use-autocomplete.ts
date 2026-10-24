import * as React from 'react';
import { completionsFor, type Completion, type CompletionList } from './schema-complete';
import { cursorContext } from './yaml-context';

export interface AutocompleteState {
  list: CompletionList;
  active: number;
  /** The partial word the pick replaces. */
  from: number;
  to: number;
  /** 1-based line and 0-based column of `from` (popup placement). */
  line: number;
  col: number;
}

/**
 * Schema autocomplete for the editor: opens while a key or value is being
 * typed (and on a fresh line where a resource can start), Ctrl+Space asks
 * explicitly; ↑↓ move, ↵ or Tab take the pick, Esc closes.
 */
export function useAutocomplete(insert: (from: number, to: number, text: string) => void) {
  const [state, setState] = React.useState<AutocompleteState | null>(null);

  const refresh = React.useCallback((text: string, offset: number, explicit = false) => {
    const ctx = cursorContext(text, offset);
    const list = completionsFor(ctx);
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const blank = text.slice(lineStart, offset).trim() === '';
    const eager = ctx.kind === 'value' || ctx.prefix.length > 0 || (blank && list?.items[0]?.kind === 'starter');
    if (!list || (!explicit && !eager)) {
      setState(null);
      return;
    }
    const line = text.slice(0, offset).split('\n').length;
    setState({ list, active: 0, from: ctx.from, to: offset, line, col: ctx.from - lineStart });
  }, []);

  const close = React.useCallback(() => setState(null), []);

  const accept = React.useCallback(
    (item?: Completion) => {
      if (!state) return;
      const pick = item ?? state.list.items[state.active];
      if (pick) insert(state.from, state.to, pick.insert);
      setState(null);
    },
    [state, insert],
  );

  /** True when the key was the popup's. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      refresh(e.currentTarget.value, e.currentTarget.selectionStart, true);
      return true;
    }
    if (!state) return false;
    const n = state.list.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setState({ ...state, active: (state.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setState(null);
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') setState(null);
    return false;
  };

  const setActive = (active: number): void => setState((s) => (s ? { ...s, active } : s));
  return { state, refresh, close, accept, onKeyDown, setActive };
}
