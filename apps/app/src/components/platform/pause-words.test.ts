import { describe, expect, it } from 'bun:test';
import { abandonWords, lastFinished, listWords, pausedNext, pausedTitle, pausingWords, type PauseRunLike } from './pause-words';

const KEYS = ['preflight', 'controller', 'agents', 'system', 'engines', 'verify'];
function paused(doneThrough: number, abandon: PauseRunLike['abandon']): PauseRunLike {
  return {
    status: 'paused',
    step: KEYS[doneThrough + 1]!,
    fromVersion: '1.2.4',
    toVersion: '1.3.0',
    error: null,
    steps: KEYS.map((key, i) => ({ key, status: i <= doneThrough ? 'done' : 'pending' })),
    abandon,
  };
}

describe('pause words', () => {
  it('says what it stopped after and what is next', () => {
    const run = paused(1, { putBack: [], kept: [{ key: 'controller', why: '…' }] });
    expect(lastFinished(run.steps)).toBe('controller');
    expect(pausedTitle(run)).toBe('Paused after the controller.');
    expect(pausedNext(run)).toBe('The agents are next. Nothing else changes until you choose; apps keep serving on what has already moved.');
    expect(pausingWords({ step: 'engines' })).toBe('Pausing after object storage: it stops as soon as that finishes.');
    expect(pausingWords({ step: 'system' })).toBe('Pausing after the system services: it stops as soon as they finish.');
  });

  it('says what Abandon puts back and what stays', () => {
    expect(abandonWords(paused(0, { putBack: [], kept: [] }))).toBe('Abandon ends the upgrade here. Nothing has changed yet.');
    expect(abandonWords(paused(3, { putBack: ['system', 'agents'], kept: [{ key: 'controller', why: '…' }] }))).toBe(
      'Abandon puts the system services and the agents back on 1.2.4, one at a time, each health-checked. The controller stays on 1.3.0: its data already moved forward.',
    );
    expect(abandonWords(paused(4, { putBack: ['system'], kept: [{ key: 'engines', why: '…' }, { key: 'controller', why: '…' }] }))).toBe(
      'Abandon puts the system services back on 1.2.4, one at a time, each health-checked. Object storage and the controller stay on 1.3.0: their data already moved forward.',
    );
  });

  it('lists in plain English', () => {
    expect(listWords([])).toBe('');
    expect(listWords(['a'])).toBe('a');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
