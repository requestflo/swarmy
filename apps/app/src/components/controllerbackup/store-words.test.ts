import { describe, expect, test } from 'bun:test';
import { storeWords, type StoreWordsInput } from './store-words';

const live: StoreWordsInput = { role: 'leader', mode: 'replicated', replicating: true, lagSeconds: 0, problem: null, hostname: 'mgr-1' };

describe('storeWords', () => {
  test('caught up and behind, in plain words', () => {
    expect(storeWords(live)).toEqual({ tone: 'ok', say: 'Copied live off this server, under a second behind' });
    expect(storeWords({ ...live, lagSeconds: 4 }).say).toEndWith('4 seconds behind');
    expect(storeWords({ ...live, lagSeconds: 42, problem: 'the replica is 42s behind' }).tone).toBe('warn');
  });

  test('never claims a lag it did not measure', () => {
    expect(storeWords({ ...live, lagSeconds: null })).toMatchObject({ tone: 'warn', say: expect.stringContaining('not known') });
    expect(storeWords({ ...live, replicating: false, lagSeconds: null }).say).toContain('not copying yet');
  });

  test('local only names the one server; fenced says it is stopping', () => {
    expect(storeWords({ ...live, mode: 'local-only', replicating: false, lagSeconds: null }).say).toStartWith('Kept on mgr-1 only');
    expect(storeWords({ ...live, role: 'fenced' }).tone).toBe('bad');
  });
});
