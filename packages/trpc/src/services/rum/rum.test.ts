import { describe, expect, it } from 'bun:test';
import { defaultRumSettings, memoryBlobStore, replayChunkKey, verifyRumToken } from '@swarmy/rum';
import { rumRouteFor } from './rum-settings.service';
import { sweepReplayChunks } from './rum-retention';

const SECRET = 's3cret';
const base = { orgId: 'org_1', stack: 'shop', upstream: 'swarmy_controller:3021', secret: SECRET };

describe('rumRouteFor', () => {
  it('off by default; a route can opt in or out', () => {
    const off = defaultRumSettings();
    expect(rumRouteFor({ ...base, settings: off })).toBeUndefined();
    expect(rumRouteFor({ ...base, settings: off, override: 'on' })?.mode).toBe('analytics');
    expect(rumRouteFor({ ...base, settings: { ...off, enabled: true }, override: 'off' })).toBeUndefined();
  });
  it('privacy mode never carries a replay rate, even if one is configured', () => {
    const r = rumRouteFor({ ...base, settings: { ...defaultRumSettings(), enabled: true, replaySampleRate: 1 } })!;
    expect(r.replaySampleRate).toBe(0);
    expect(verifyRumToken(SECRET, r.token)).toEqual({ o: 'org_1', a: 'shop', m: 'a', s: 0, r: 14 });
  });
  it('identified mode signs the replay rate + retention into the token', () => {
    const r = rumRouteFor({
      ...base,
      settings: { ...defaultRumSettings(), enabled: true, mode: 'identified', replaySampleRate: 0.1, retentionDays: 30, consent: 'cmp' },
    })!;
    expect(r).toMatchObject({ mode: 'identified', replaySampleRate: 0.1, consent: 'cmp' });
    expect(verifyRumToken(SECRET, r.token)).toEqual({ o: 'org_1', a: 'shop', m: 'i', s: 0.1, r: 30 });
  });
  it('standalone services (no stack) are never injected', () => {
    expect(rumRouteFor({ ...base, stack: '(ungrouped)', settings: { ...defaultRumSettings(), enabled: true } })).toBeUndefined();
  });
});

describe('replay chunk retention sweep', () => {
  it('deletes only day prefixes older than each app retention', async () => {
    const store = memoryBlobStore();
    const put = (app: string, day: string, sid: string) => store.put(replayChunkKey('org_1', app, day, sid, 0), new Uint8Array([1]));
    await put('shop', '2026-09-01', 'aaaaaaaaaa');
    await put('shop', '2026-09-20', 'bbbbbbbbbb');
    await put('blog', '2026-09-01', 'cccccccccc');
    await store.put(replayChunkKey('org_2', 'shop', '2026-01-01', 'dddddddddd', 0), new Uint8Array([1]));
    const r = await sweepReplayChunks(store, 'org_1', (app) => (app === 'blog' ? 90 : 14), new Date('2026-09-24T00:00:00Z'));
    expect(r).toEqual({ apps: 2, daysDeleted: 1, objectsDeleted: 1 });
    expect([...store.objects.keys()].sort()).toEqual([
      'rum/org_1/blog/2026-09-01/cccccccccc/000000.json.gz',
      'rum/org_1/shop/2026-09-20/bbbbbbbbbb/000000.json.gz',
      'rum/org_2/shop/2026-01-01/dddddddddd/000000.json.gz',
    ]);
  });
});
