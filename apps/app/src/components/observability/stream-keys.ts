/** The stream's keyboard: j/k move, Enter opens, e jumps to the next error, space pauses, Esc closes, / searches. */
export type StreamKey = 'down' | 'up' | 'open' | 'next-error' | 'pause' | 'close' | 'search';

export interface StreamNav {
  /** The line the cursor is on (by key, so live inserts don't move it). */
  cursor: string | null;
  /** The line whose detail / trace is open. */
  open: string | null;
  paused: boolean;
}

export interface NavLine {
  key: string;
  error: boolean;
}

export const INITIAL_NAV: StreamNav = { cursor: null, open: null, paused: false };

/**
 * Pure keyboard reducer over the visible lines (in screen order, oldest at
 * the top). Opening a line pauses the stream so it stays where you're reading.
 */
export function streamNav(state: StreamNav, key: StreamKey, lines: NavLine[]): StreamNav {
  const at = state.cursor === null ? -1 : lines.findIndex((l) => l.key === state.cursor);
  const last = lines.length - 1;
  switch (key) {
    case 'down':
      if (last < 0) return state;
      return { ...state, cursor: lines[at < 0 ? last : Math.min(at + 1, last)]!.key };
    case 'up':
      if (last < 0) return state;
      return { ...state, cursor: lines[at < 0 ? last : Math.max(at - 1, 0)]!.key };
    case 'open': {
      const target = at < 0 ? null : lines[at]!.key;
      if (!target) return state;
      return target === state.open ? { ...state, open: null } : { ...state, open: target, paused: true };
    }
    case 'next-error': {
      const n = lines.length;
      for (let i = 1; i <= n; i++) {
        const l = lines[(Math.max(at, -1) + i + n) % n]!;
        if (l.error) return { cursor: l.key, open: l.key, paused: true };
      }
      return state;
    }
    case 'pause':
      return { ...state, paused: !state.paused };
    case 'close':
      return { ...state, open: null };
    case 'search':
      return state;
  }
}

export type NavAction =
  | { kind: 'key'; key: StreamKey; lines: NavLine[] }
  | { kind: 'toggle'; key: string }
  | { kind: 'focus'; key: string }
  | { kind: 'paused'; paused: boolean };

/** The `useReducer` wrapper: keys, a click on a line, focus landing on a line, Pause/Resume. */
export function navReducer(state: StreamNav, a: NavAction): StreamNav {
  switch (a.kind) {
    case 'key':
      return streamNav(state, a.key, a.lines);
    case 'toggle':
      return a.key === state.open ? { ...state, cursor: a.key, open: null } : { cursor: a.key, open: a.key, paused: true };
    case 'focus':
      return state.cursor === a.key ? state : { ...state, cursor: a.key };
    case 'paused':
      return { ...state, paused: a.paused };
  }
}

/** Map a keydown to a stream key, or null when it belongs to something else (typing, modifiers). */
export function keyFromEvent(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>, target: { tag: string; editable: boolean }): StreamKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const typing = target.editable || target.tag === 'INPUT' || target.tag === 'TEXTAREA' || target.tag === 'SELECT';
  if (typing) return e.key === 'Escape' ? 'close' : null;
  switch (e.key) {
    case 'j':
      return 'down';
    case 'k':
      return 'up';
    case 'Enter':
      return 'open';
    case 'e':
      return 'next-error';
    case ' ':
      return 'pause';
    case 'Escape':
      return 'close';
    case '/':
      return 'search';
    default:
      return null;
  }
}
