import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { fireEvent, notifyDecision, releaseHeld, resolveEvent } from './alerts-fire';
import { createRule, getQuietHours, muteRule, setQuietHours, unmuteRule, updateRule } from './alerts.service';

/**
 * Owner decision Q10 against a real store: several rules per signal with
 * their own targets, "Mute for 1h", and quiet hours that hold warnings and
 * send them once when the window ends (if still firing).
 */
process.env.SWARMY_SECRET_KEY ??= 'a'.repeat(64);

let t: TestDb;
let orgSeq = 0;
const sent: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await createTestDb();
  globalThis.fetch = (async (url: string | URL | Request) => {
    sent.push(String(url));
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
});
afterEach(() => {
  sent.length = 0;
});

const SLACK = 'https://hooks.test/slack';
const PHONE = 'https://hooks.test/phone';

/** A fresh org with two webhook channels ("slack" and "phone"). */
async function org(): Promise<{ ctx: OrgContext; slack: string; phone: string }> {
  const id = `org_${++orgSeq}`;
  await t.db.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  const ctx = { db: t.db, hub: {}, activeOrgId: id, user: null } as unknown as OrgContext;
  const channel = async (name: string, url: string): Promise<string> =>
    (
      await t.db.notificationChannel.create({
        data: { orgId: id, name, kind: 'WEBHOOK', configEnc: encryptSecret(JSON.stringify({ kind: 'webhook', url })) },
      })
    ).id;
  return { ctx, slack: await channel('slack', SLACK), phone: await channel('phone', PHONE) };
}

const events = (ctx: OrgContext) =>
  t.db.alertEvent.findMany({ where: { orgId: ctx.activeOrgId }, orderBy: { firedAt: 'asc' } });

const rateFire = (resource: string, severity: 'warning' | 'critical' = 'warning') => ({
  signal: 'error-rate',
  severity,
  resource,
  message: `Error rate on ${resource} is high`,
});

/** HH:MM in UTC, `min` minutes from now. */
const hhmm = (min: number): string => {
  const d = new Date(Date.now() + min * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

describe('notifyDecision (pure)', () => {
  const now = new Date('2026-09-27T03:00:00Z');
  const quiet = { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC', criticalPages: true };
  it('a muted rule sends nothing, whatever the severity', () => {
    expect(notifyDecision({ severity: 'critical', mutedUntil: new Date('2026-09-27T04:00:00Z'), quiet: null, now })).toBe('mute');
    expect(notifyDecision({ severity: 'critical', mutedUntil: new Date('2026-09-27T02:00:00Z'), quiet: null, now })).toBe('send');
  });
  it('quiet hours hold warnings; critical still pages unless turned off', () => {
    expect(notifyDecision({ severity: 'warning', mutedUntil: null, quiet, now })).toBe('hold');
    expect(notifyDecision({ severity: 'critical', mutedUntil: null, quiet, now })).toBe('send');
    expect(notifyDecision({ severity: 'critical', mutedUntil: null, quiet: { ...quiet, criticalPages: false }, now })).toBe('hold');
    expect(notifyDecision({ severity: 'warning', mutedUntil: null, quiet, now: new Date('2026-09-27T08:00:00Z') })).toBe('send');
  });
});

describe('several rules per signal, each with its own target', () => {
  it('fans a slice fire out to every rule whose target covers the subject, each deduping its own event', async () => {
    const { ctx, slack, phone } = await org();
    const shop = await createRule(ctx, {
      name: 'Storefront errors', signal: 'error-rate', selector: { app: 'storefront' }, threshold: 5, forSeconds: 0, channelIds: [slack], enabled: true,
    });
    const checkout = await createRule(ctx, {
      name: 'Checkout errors', signal: 'error-rate', selector: { app: 'storefront', service: 'checkout' }, threshold: 2, forSeconds: 0, channelIds: [phone], enabled: true,
    });

    await fireEvent(ctx, rateFire('service:storefront_checkout'));
    let rows = await events(ctx);
    expect(rows.map((e) => e.ruleId).sort()).toEqual([shop.id, checkout.id].sort());
    expect(sent.sort()).toEqual([PHONE, SLACK]);

    sent.length = 0;
    await fireEvent(ctx, rateFire('service:storefront_web'));
    await fireEvent(ctx, rateFire('service:blog_web')); // nobody's target
    rows = await events(ctx);
    expect(rows.slice(2).map((e) => `${e.ruleId === shop.id ? 'shop' : 'checkout'}:${e.resource}`)).toEqual([
      'shop:service:storefront_web',
    ]);
    expect(sent).toEqual([SLACK]);

    // A repeat fire refreshes each rule's open row instead of stacking one.
    sent.length = 0;
    await fireEvent(ctx, rateFire('service:storefront_checkout'));
    expect((await events(ctx)).length).toBe(3);
    expect(sent).toEqual([]);

    // Resolving one rule's event leaves the other rule's open.
    await resolveEvent(ctx, 'error-rate', 'service:storefront_checkout', undefined, checkout.id);
    const open = (await events(ctx)).filter((e) => e.status === 'FIRING').map((e) => `${e.ruleId}:${e.resource}`);
    expect(open.sort()).toEqual([`${shop.id}:service:storefront_checkout`, `${shop.id}:service:storefront_web`].sort());
  });

  it('rejects a target the signal cannot take', async () => {
    const { ctx } = await org();
    const base = { name: 'x', threshold: null, forSeconds: 0, channelIds: [] as string[], enabled: true };
    await expect(createRule(ctx, { ...base, signal: 'error-rate', selector: { server: 'london-2' } })).rejects.toThrow('one server');
    await expect(createRule(ctx, { ...base, signal: 'backup-failed', selector: { app: 'blog' } })).rejects.toThrow('one app');
    const disk = await createRule(ctx, { ...base, signal: 'disk-usage', selector: { server: 'london-2' } });
    expect(disk.selector).toEqual({ server: 'london-2' });
    await expect(updateRule(ctx, { id: disk.id, selector: { app: 'shop' } })).rejects.toThrow('one app');
    expect((await updateRule(ctx, { id: disk.id, selector: {} })).selector).toEqual({});
  });
});

describe('Mute for 1h', () => {
  it('records events but sends nothing; unmuting sends a still-firing one once', async () => {
    const { ctx, slack } = await org();
    const rule = await createRule(ctx, {
      name: 'Errors', signal: 'error-rate', selector: {}, threshold: 5, forSeconds: 0, channelIds: [slack], enabled: true,
    });
    const muted = await muteRule(ctx, { id: rule.id, minutes: 60 });
    expect(Date.parse(muted.mutedUntil!) - Date.now()).toBeGreaterThan(59 * 60_000);

    await fireEvent(ctx, rateFire('service:shop_web', 'critical'));
    await fireEvent(ctx, rateFire('service:shop_api'));
    expect((await events(ctx)).map((e) => e.notify)).toEqual(['MUTED', 'MUTED']);
    expect(sent).toEqual([]);
    expect(await releaseHeld(ctx)).toBe(0); // still muted

    // One resolves while muted: it is never sent.
    await resolveEvent(ctx, 'error-rate', 'service:shop_api');
    expect(sent).toEqual([]);

    const unmuted = await unmuteRule(ctx, { id: rule.id });
    expect(unmuted.mutedUntil).toBeNull();
    expect(sent).toEqual([SLACK]); // the still-firing one, once
    expect((await events(ctx)).map((e) => [e.resource, e.notify])).toEqual([
      ['service:shop_web', 'SENT'],
      ['service:shop_api', 'SKIPPED'],
    ]);
    expect(await releaseHeld(ctx)).toBe(0);
  });
});

describe('quiet hours', () => {
  it('holds warnings, pages critical, and sends still-firing held events once when they end', async () => {
    const { ctx, slack, phone } = await org();
    expect(await getQuietHours(ctx)).toMatchObject({ enabled: false, start: '22:00', end: '07:00', criticalPages: true, activeNow: false });
    await createRule(ctx, { name: 'Errors', signal: 'error-rate', selector: {}, threshold: 5, forSeconds: 0, channelIds: [slack], enabled: true });
    await createRule(ctx, { name: 'Down', signal: 'service-down', selector: {}, threshold: null, forSeconds: 0, channelIds: [phone], enabled: true });

    const q = await setQuietHours(ctx, { enabled: true, start: hhmm(-60), end: hhmm(60), timeZone: 'UTC', criticalPages: true });
    expect(q.activeNow).toBe(true);

    await fireEvent(ctx, rateFire('service:shop_web')); // warning → held
    await fireEvent(ctx, rateFire('service:shop_api')); // warning → held, resolves while quiet
    await fireEvent(ctx, { signal: 'service-down', severity: 'critical', resource: 'service:shop_db', message: 'down' });
    expect(sent).toEqual([PHONE]); // critical still pages
    expect((await events(ctx)).map((e) => e.notify)).toEqual(['HELD', 'HELD', 'SENT']);
    expect(await releaseHeld(ctx)).toBe(0); // still quiet

    await resolveEvent(ctx, 'error-rate', 'service:shop_api');
    expect(sent).toEqual([PHONE]); // no recovery for something never sent

    // Quiet hours end (turned off here): the still-firing held warning goes out once.
    sent.length = 0;
    await setQuietHours(ctx, { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC', criticalPages: true });
    expect(sent).toEqual([SLACK]);
    expect((await events(ctx)).map((e) => [e.resource, e.notify])).toEqual([
      ['service:shop_web', 'SENT'],
      ['service:shop_api', 'SKIPPED'],
      ['service:shop_db', 'SENT'],
    ]);
    expect(await releaseHeld(ctx)).toBe(0);
  });

  it('holds critical too when "critical alerts still page" is off', async () => {
    const { ctx, phone } = await org();
    await createRule(ctx, { name: 'Down', signal: 'service-down', selector: {}, threshold: null, forSeconds: 0, channelIds: [phone], enabled: true });
    await setQuietHours(ctx, { enabled: true, start: hhmm(-60), end: hhmm(60), timeZone: 'UTC', criticalPages: false });
    await fireEvent(ctx, { signal: 'service-down', severity: 'critical', resource: 'service:shop_db', message: 'down' });
    expect(sent).toEqual([]);
    expect((await events(ctx))[0]?.notify).toBe('HELD');
  });
});
