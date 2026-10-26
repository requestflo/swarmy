import { describe, expect, test } from 'bun:test';
import { copyWords } from './copy-words';
import { fitCheck } from './fit-check';

const GB = 1024 ** 3;
const dest = { usedBytes: 6 * GB, totalBytes: 16 * GB };
const ok = { ok: true as const, replicas: 3, body: 'web runs 2 copies now. One more starts on wkr-3 and shares the load; nothing moves and nothing restarts.', note: null };
const base = { short: 'web', target: 'wkr-3', failed: null };

describe('the ⌥-drag preview words', () => {
  test('a copy Swarm would start there, with room: ask once', () => {
    const w = copyWords({ ...base, answer: ok, fit: fitCheck({ needBytes: GB, dest }) });
    expect(w).toEqual({ tone: 'ok', verdict: 'Fits', title: 'Add a copy of web on wkr-3?', body: ok.body, go: true });
  });

  test("the controller's refusal is the title, and nothing can be added", () => {
    const reason = 'web keeps its data on its server (shop_uploads). A copy on wkr-3 would start with an empty volume, not with that data. Drag it without ⌥ to move it instead.';
    const w = copyWords({ ...base, answer: { ok: false, reason }, fit: fitCheck({ needBytes: GB, dest }) });
    expect(w).toMatchObject({ tone: 'bad', title: reason, go: false });
  });

  test("no room for one more copy's memory refuses; a tight fit says how full", () => {
    expect(copyWords({ ...base, answer: ok, fit: fitCheck({ needBytes: 11 * GB, dest }) })).toMatchObject({ verdict: 'Won’t fit', go: false });
    const tight = copyWords({ ...base, answer: { ...ok, note: 'wkr-2 is just as free, so Swarm may start it there instead.' }, fit: fitCheck({ needBytes: 7.2 * GB, dest }) });
    expect(tight.go).toBe(true);
    expect(tight.body).toBe(`${ok.body} wkr-2 is just as free, so Swarm may start it there instead. wkr-3 would use 83% of its memory.`);
  });

  test('while checking, nothing is offered; a failed check says so', () => {
    expect(copyWords({ ...base, answer: undefined, fit: fitCheck({ needBytes: null, dest }) })).toMatchObject({ verdict: 'Checking', go: false });
    expect(copyWords({ ...base, failed: 'timed out', answer: undefined, fit: fitCheck({ needBytes: null, dest }) })).toMatchObject({ tone: 'bad', body: 'timed out', go: false });
  });
});
