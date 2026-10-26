import { describe, expect, test } from 'bun:test';
import { outcomeWords, UNDO_STEP_ORDER, undoOffer } from './move-outcome';
import { STEP_ORDER } from './move-rules';

const o = { short: 'clickhouse', from: 'london-2', to: 'home-lab' };

describe('the move card after a move, and its Undo', () => {
  test('a finished move says how long Undo can use the old copy', () => {
    expect(outcomeWords({ ...o, phase: 'done', undo: false })).toEqual({
      tone: 'ok',
      word: 'Moved',
      title: 'clickhouse now runs on home-lab.',
      body: 'The old copy stays on london-2: Undo can use it for 24 hours, and london-2’s page asks about it after 7 days.',
    });
  });

  test('an Undo copies nothing, and says where it ended up either way', () => {
    // An Undo run goes from the new server back to the old one.
    const back = { short: 'clickhouse', from: 'home-lab', to: 'london-2' };
    expect(outcomeWords({ ...back, phase: 'moving', undo: true }).title).toBe('Putting clickhouse back on london-2');
    expect(outcomeWords({ ...back, phase: 'done', undo: true })).toMatchObject({ word: 'Put back', title: 'clickhouse is back on london-2.' });
    expect(outcomeWords({ ...back, phase: 'done', undo: true }).body).toContain('Nothing was copied');
    expect(outcomeWords({ ...back, phase: 'rolled-back', undo: true })).toMatchObject({ tone: 'warn', title: 'clickhouse stays on home-lab.' });
  });

  test('its steps are the stopped half of a move, in order', () => {
    expect(UNDO_STEP_ORDER.every((s) => STEP_ORDER.includes(s))).toBe(true);
    expect(UNDO_STEP_ORDER).toEqual(['stop', 'verify', 'repin', 'start']);
  });

  test('the offer names the old server and the condition', () => {
    expect(undoOffer('clickhouse', 'london-2')).toBe('Undo puts clickhouse back on london-2, on the copy it left there, if nothing has written to either copy since.');
  });
});
