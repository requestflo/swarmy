import { describe, expect, it } from 'bun:test';
import { convertStatus, sentence, sortGaps } from './convert-model';

describe('convert model', () => {
  it('says the parser’s verdict the way the scan board does', () => {
    expect(convertStatus([])).toEqual({ tone: 'ok', text: 'valid · v1' });
    expect(convertStatus([{ severity: 'warning', line: 3 }])).toEqual({ tone: 'warn', text: 'valid · v1 · 1 warning' });
    expect(convertStatus([{ severity: 'warning' }, { severity: 'error', line: 14 }, { severity: 'error' }])).toEqual({ tone: 'bad', text: '2 problems · line 14' });
  });

  it('puts what was lost before what swarmy does itself, keeping file order', () => {
    const g = (key: string, handled?: true) => ({ service: 'web', key, reason: 'r', ...(handled ? { handled } : {}) });
    expect(sortGaps([g('depends_on', true), g('privileged'), g('restart', true), g('cap_add')]).map((x) => x.key)).toEqual([
      'privileged',
      'cap_add',
      'depends_on',
      'restart',
    ]);
  });

  it('turns a reason into a sentence without capitalising the brand', () => {
    expect(sentence("the data in it doesn't move")).toBe("The data in it doesn't move.");
    expect(sentence('swarmy restarts a service that stops')).toBe('swarmy restarts a service that stops.');
    expect(sentence('swarmy.yaml has no stop settings')).toBe('swarmy.yaml has no stop settings.');
    expect(sentence('it reads ${{ secrets.x }}.')).toBe('It reads ${{ secrets.x }}.');
  });
});
