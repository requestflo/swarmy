import { describe, expect, test } from 'bun:test';
import { agoLabel, dayMarks, eventsAt, groupEvents, stepTo, travelEvents, WEEK_MS } from './time-travel-model';
import { ago, H, INCIDENT, NOW, RELEASES, SAVES } from './time-travel-fixtures';

describe('travelEvents', () => {
  const events = travelEvents({
    releases: RELEASES,
    incidents: [INCIDENT],
    snapshots: [{ id: 'v1', volume: 'storefront_checkout', status: 'FAILED', startedAt: ago(9 * H) }],
    dbBackups: SAVES,
    now: NOW,
  });

  test('keeps the last 7 days only, oldest first, on three lanes', () => {
    expect(events.map((e) => e.id)).toEqual(['deploy-r3', 'save-s81', 'save-s57', 'save-s33', 'deploy-r4', 'incident-inc-1', 'deploy-r5', 'backup-v1', 'deploy-r6']);
    expect(events.every((e) => e.pos >= 0 && e.pos <= 1)).toBe(true);
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(['deploy', 'incident', 'backup']));
  });

  test('says what happened in plain words; a failed backup is marked', () => {
    expect(events.find((e) => e.id === 'deploy-r4')?.title).toBe('v1.8.3 went out, then was put back');
    expect(events.find((e) => e.id === 'backup-v1')).toMatchObject({ title: 'Backing up checkout failed', failed: true });
  });

  test('events at T and stepping between them', () => {
    const r4 = NOW - (26 * H + 20 * 60_000);
    expect(eventsAt(events, r4).map((e) => e.id)).toEqual(['deploy-r4']);
    expect(eventsAt(events, r4, 5 * 60_000).map((e) => e.id)).toEqual(['deploy-r4', 'incident-inc-1']);
    expect(eventsAt(events, NOW - 2 * H)).toEqual([]);
    expect(stepTo(events, r4, 1, NOW)).toBe(NOW - (26 * H + 17 * 60_000));
    expect(stepTo(events, r4, -1, NOW)).toBe(NOW - 33 * H);
    expect(stepTo(events, NOW - 20 * 60_000, 1, NOW)).toBe(NOW);
    expect(stepTo(events, NOW - 81 * H, -1, NOW)).toBe(NOW - 96 * H);
    expect(stepTo(events, NOW - 96 * H, -1, NOW)).toBe(NOW - 96 * H);
  });

  test('close events share a lane button', () => {
    const deploys = events.filter((e) => e.kind === 'deploy');
    expect(groupEvents(deploys, 0.01).map((g) => g.length)).toEqual([1, 2, 1]);
  });
});

describe('labels', () => {
  test('ago words', () => {
    expect(agoLabel(NOW, NOW)).toBe('now');
    expect(agoLabel(NOW - 40 * 60_000, NOW)).toBe('40 min ago');
    expect(agoLabel(NOW - (2 * 24 + 3) * H, NOW)).toBe('2 d 3 h ago');
  });

  test('a mark at every local midnight in the week', () => {
    const marks = dayMarks(NOW);
    expect(marks.length).toBe(7);
    expect(marks.every((m) => m.pos > 0 && m.pos <= 1)).toBe(true);
    expect(marks[0]!.pos).toBeLessThan(1 / 7 + 1e-9 + (60 * 60 * 1000) / WEEK_MS);
  });
});
