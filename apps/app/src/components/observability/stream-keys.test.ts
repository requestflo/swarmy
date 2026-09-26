import { describe, expect, test } from 'bun:test';
import { INITIAL_NAV, keyFromEvent, navReducer, streamNav, type NavLine } from './stream-keys';

const lines: NavLine[] = [
  { key: 'a', error: false },
  { key: 'b', error: true },
  { key: 'c', error: false },
  { key: 'd', error: true },
];

describe('streamNav', () => {
  test('j/k start at the newest line (the bottom) and clamp at the ends', () => {
    const s1 = streamNav(INITIAL_NAV, 'down', lines);
    expect(s1.cursor).toBe('d');
    expect(streamNav(s1, 'down', lines).cursor).toBe('d');
    const up = streamNav(streamNav(streamNav(streamNav(s1, 'up', lines), 'up', lines), 'up', lines), 'up', lines);
    expect(up.cursor).toBe('a');
    expect(streamNav(INITIAL_NAV, 'down', [])).toBe(INITIAL_NAV);
  });

  test('Enter opens the cursor line (and pauses), again closes it', () => {
    const at = { ...INITIAL_NAV, cursor: 'c' };
    const open = streamNav(at, 'open', lines);
    expect(open).toEqual({ cursor: 'c', open: 'c', paused: true });
    expect(streamNav(open, 'open', lines).open).toBeNull();
    expect(streamNav(INITIAL_NAV, 'open', lines)).toBe(INITIAL_NAV);
  });

  test('e jumps to and opens the next error, wrapping round', () => {
    const e1 = streamNav(INITIAL_NAV, 'next-error', lines);
    expect(e1).toEqual({ cursor: 'b', open: 'b', paused: true });
    expect(streamNav(e1, 'next-error', lines).cursor).toBe('d');
    expect(streamNav({ ...e1, cursor: 'd' }, 'next-error', lines).cursor).toBe('b');
    expect(streamNav(INITIAL_NAV, 'next-error', [{ key: 'x', error: false }])).toBe(INITIAL_NAV);
  });

  test('space toggles pause, Esc closes', () => {
    expect(streamNav(INITIAL_NAV, 'pause', lines).paused).toBe(true);
    expect(streamNav({ cursor: 'b', open: 'b', paused: true }, 'close', lines)).toEqual({ cursor: 'b', open: null, paused: true });
  });
});

describe('navReducer', () => {
  test('a click toggles the line, focus moves the cursor, Resume unpauses', () => {
    const opened = navReducer(INITIAL_NAV, { kind: 'toggle', key: 'c' });
    expect(opened).toEqual({ cursor: 'c', open: 'c', paused: true });
    expect(navReducer(opened, { kind: 'toggle', key: 'c' }).open).toBeNull();
    expect(navReducer(opened, { kind: 'focus', key: 'a' }).cursor).toBe('a');
    expect(navReducer(opened, { kind: 'focus', key: 'c' })).toBe(opened);
    expect(navReducer(opened, { kind: 'paused', paused: false }).paused).toBe(false);
  });
});

describe('keyFromEvent', () => {
  const ev = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  const body = { tag: 'BODY', editable: false };
  test('maps the stream keys', () => {
    expect(['j', 'k', 'Enter', 'e', ' ', 'Escape', '/', 'x'].map((k) => keyFromEvent(ev(k), body))).toEqual(['down', 'up', 'open', 'next-error', 'pause', 'close', 'search', null]);
  });
  test('ignores typing and modifier chords', () => {
    expect(keyFromEvent(ev('j'), { tag: 'INPUT', editable: false })).toBeNull();
    expect(keyFromEvent(ev('e'), { tag: 'DIV', editable: true })).toBeNull();
    expect(keyFromEvent(ev('Escape'), { tag: 'INPUT', editable: false })).toBe('close');
    expect(keyFromEvent(ev('k', { metaKey: true }), body)).toBeNull();
  });
});
