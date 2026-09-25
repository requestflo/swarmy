import { describe, expect, test } from 'bun:test';
import type { AppWords } from './app-words';
import { appsSay, estateSay } from './estate-say';

const w = (tone: AppWords['tone'], attention = false): AppWords => ({ tone, attention, word: '', say: '', tech: '' });
const base = { alertsFiring: 0, incidentsOpen: 0, nodesOnline: 3, nodesTotal: 3 };

describe('estateSay', () => {
  test('all calm', () => {
    const apps = ['a', 'b', 'c'].map((name) => ({ name, words: w('ok') }));
    expect(estateSay({ ...base, apps })).toEqual({ lead: 'Three apps are calm.', clause: null });
  });
  test('one app needs you', () => {
    const apps = [
      { name: 'storefront', words: w('ok') },
      { name: 'analytics', words: w('warn', true) },
    ];
    expect(estateSay({ ...base, apps })).toEqual({
      lead: 'One app is calm.',
      clause: { tone: 'warn', text: 'analytics needs you.' },
    });
  });
  test('a down app is bad', () => {
    const apps = [{ name: 'blog', words: w('bad', true) }];
    expect(estateSay({ ...base, apps }).clause).toEqual({ tone: 'bad', text: 'blog is down.' });
  });
  test('calm apps but alerts firing', () => {
    const apps = [{ name: 'blog', words: w('ok') }];
    expect(estateSay({ ...base, alertsFiring: 2, apps })).toEqual({
      lead: 'blog is calm.',
      clause: { tone: 'warn', text: 'Two alerts are firing.' },
    });
  });
  test('an offline server', () => {
    const apps = [{ name: 'a', words: w('ok') }, { name: 'b', words: w('ok') }];
    expect(estateSay({ ...base, nodesOnline: 2, apps }).clause?.text).toBe('A server is offline.');
  });
  test('apps page lead', () => {
    const apps = [{ name: 'a', words: w('ok') }, { name: 'platform', words: w('warn', true) }];
    expect(appsSay({ ...base, apps })).toEqual({ lead: '2 apps.', clause: { tone: 'warn', text: 'platform needs you.' } });
  });
});
