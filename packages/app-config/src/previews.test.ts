import { describe, expect, it } from 'bun:test';
import { parseAppConfig } from './parse';
import { toDesired } from './desired';
import { PREVIEW_SLEEP_AFTER_SECONDS, previewIdleSeconds, previewSleepSeconds } from './previews';

const yaml = (previews: string, webExtra = ''): string => `version: 1
app: shop
services:
  web:
    build: .
    port: 3000
    domains: [shop.example.com]${webExtra}
  worker:
    build: .
    command: node worker.js
previews:
  enabled: true
  base_domain: preview.example.com${previews}
`;

function previewWeb(text: string) {
  const parsed = parseAppConfig(text);
  expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const d = toDesired(parsed.config!, { preview: { pr: 7, baseDomain: 'preview.example.com' } });
  return { d, web: d.services.find((s) => s.name === 'web')!, worker: d.services.find((s) => s.name === 'worker')! };
}

describe('previews sleep when idle (board 68: "sleeps after 2 h idle")', () => {
  it('a routed preview service sleeps after 2 h by default; one with no address stays up', () => {
    const { d, web, worker } = previewWeb(yaml(''));
    expect(PREVIEW_SLEEP_AFTER_SECONDS).toBe(7200);
    expect(web.sleepAfterSeconds).toBe(7200);
    expect(worker.sleepAfterSeconds).toBeUndefined();
    expect(d.previews.sleepAfterSeconds).toBe(7200);
  });

  it('previews.sleep_after sets it per app, over the service’s own sleep_after', () => {
    expect(previewWeb(yaml('\n  sleep_after: 30m', '\n    sleep_after: 5m')).web.sleepAfterSeconds).toBe(1800);
    // Unset: the service's own window, then the 2 h default.
    expect(previewWeb(yaml('', '\n    sleep_after: 5m')).web.sleepAfterSeconds).toBe(300);
  });

  it('never keeps a preview up', () => {
    const { d, web } = previewWeb(yaml('\n  sleep_after: never'));
    expect(web.sleepAfterSeconds).toBeUndefined();
    expect(d.previews.sleepAfterSeconds).toBeNull();
  });

  it('production is never put to sleep by the preview rule', () => {
    const prod = toDesired(parseAppConfig(yaml('\n  sleep_after: 10m')).config!);
    expect(prod.services.find((s) => s.name === 'web')?.sleepAfterSeconds).toBeUndefined();
  });

  it('the rule, on its own', () => {
    expect(previewSleepSeconds({ previewsSleepAfter: undefined, serviceSleepSeconds: undefined, routed: true })).toBe(7200);
    expect(previewSleepSeconds({ previewsSleepAfter: '8h', serviceSleepSeconds: 60, routed: true })).toBe(28_800);
    expect(previewSleepSeconds({ previewsSleepAfter: '8h', serviceSleepSeconds: 60, routed: false })).toBe(60);
    expect(previewIdleSeconds(undefined)).toBe(7200);
    expect(previewIdleSeconds(900)).toBe(900);
    expect(previewIdleSeconds('never')).toBeNull();
  });

  it('sleep_after takes a duration or never, nothing else', () => {
    const bad = parseAppConfig(yaml('\n  sleep_after: sometimes'));
    expect(bad.config).toBeUndefined();
  });
});
