import { describe, expect, test } from 'bun:test';
import { planAppRestore } from '@swarmy/core';
import { partWords, refusalWords, skewSentence, spanWords } from './app-restore-words';
import { clockLabel, momentLabel } from './time-travel-model';
import { ago, H, NOW, SAVES } from './time-travel-fixtures';

const T = NOW - 33 * H + 2 * 60_000;
const volume = (volume: string, msAgo: number) => ({ volume, saves: [{ id: `v-${volume}`, status: 'SUCCEEDED', startedAt: ago(msAgo) }] });

describe('whole-app restore words', () => {
  test('says how far apart the parts land, naming them when there are several', () => {
    const one = planAppRestore({ at: T, volumes: [volume('storefront_uploads', 33 * H + 60 * 60_000)], databases: [{ cluster: 'checkout', saves: SAVES, pitr: null }] });
    expect(skewSentence(one, 'storefront')).toBe(`Files from ${clockLabel(NOW - 34 * H)}, the database from ${clockLabel(NOW - 33 * H)}.`);
    const two = planAppRestore({ at: T, volumes: [volume('storefront_uploads', 34 * H), volume('storefront_media', 33 * H)], databases: [] });
    expect(skewSentence(two, 'storefront')).toBe(`Uploads from ${clockLabel(NOW - 34 * H)}, media from ${clockLabel(NOW - 33 * H)}.`);
    const close = planAppRestore({ at: T, volumes: [volume('storefront_uploads', 33 * H)], databases: [{ cluster: 'checkout', saves: SAVES, pitr: null }] });
    expect(skewSentence(close, 'storefront')).toBe(`Everything from ${clockLabel(NOW - 33 * H)}.`);
  });

  test('says how each part gets there', () => {
    const plan = planAppRestore({
      at: T,
      volumes: [volume('storefront_uploads', 33 * H)],
      databases: [{ cluster: 'orders', saves: [], pitr: { engine: 'wal-g', window: { from: ago(80 * H), to: ago(10 * H) } } }],
    });
    expect(partWords(plan.parts[0]!, T)).toBe(`the save of ${clockLabel(NOW - 33 * H)}, 2 min before`);
    expect(partWords(plan.parts[1]!, T)).toBe(`replayed to ${clockLabel(T)} exactly`);
  });

  test('spans and refusals', () => {
    expect([spanWords(30_000), spanWords(2 * 60_000), spanWords(65 * 60_000), spanWords(27 * H)]).toEqual(['30 s', '2 min', '1 h 5 min', '1 d 3 h']);
    expect(refusalWords({ kind: 'volume', name: 'x', reachesFrom: null })).toBe('has no save yet');
    expect(refusalWords({ kind: 'volume', name: 'x', reachesFrom: NOW })).toBe(`only goes back to ${momentLabel(NOW)}`);
  });
});
