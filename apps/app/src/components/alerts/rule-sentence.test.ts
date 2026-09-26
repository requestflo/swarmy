import { describe, expect, test } from 'bun:test';
import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { isMuted, resourceName, ruleForEvent, ruleSentence } from './rule-sentence';
import { phraseTargetsAgree } from './signal-phrases';

const ch = (id: string, name: string): NotificationChannelView => ({
  id, name, kind: 'slack', enabled: true, target: 'hooks.slack.com', hasSecret: false, createdAt: '2026-09-01T00:00:00Z',
});
const rule = (over: Partial<AlertRuleView>): AlertRuleView => ({
  id: 'r', name: 'Error rate high', signal: 'error-rate', selector: {}, mutedUntil: null, threshold: 5, forSeconds: 0, channelIds: [],
  enabled: true, isDefault: true, createdAt: '2026-09-01T00:00:00Z', ...over,
});

describe('ruleSentence', () => {
  const channels = [ch('a', '#ops Slack'), ch('b', 'On-call email')];
  test('threshold signal with a hold and one channel, any app', () => {
    expect(ruleSentence({ signal: 'error-rate', selector: {}, threshold: 5, forSeconds: 300, channelIds: ['a'] }, channels)).toBe(
      'When error rate of any app is above 5% for 5 min → #ops Slack',
    );
  });
  test('the target follows the metric: one app, or one part of it', () => {
    expect(ruleSentence({ signal: 'error-rate', selector: { app: 'storefront' }, threshold: 5, forSeconds: 0, channelIds: ['a'] }, channels)).toBe(
      'When error rate of storefront is above 5% → #ops Slack',
    );
    expect(
      ruleSentence({ signal: 'error-rate', selector: { app: 'storefront', service: 'checkout' }, threshold: 2, forSeconds: 300, channelIds: ['b'] }, channels),
    ).toBe('When error rate of storefront / checkout is above 2% for 5 min → On-call email');
  });
  test('server signals say "on" a server', () => {
    expect(ruleSentence({ signal: 'disk-usage', selector: { server: 'london-2' }, threshold: 85, forSeconds: 0, channelIds: [] }, channels)).toBe(
      'When disk used on london-2 is above 85% → every channel',
    );
    expect(ruleSentence({ signal: 'node-offline', selector: {}, threshold: null, forSeconds: 300, channelIds: ['a', 'b'] }, channels)).toBe(
      'When checking in stops on any server for 5 min → #ops Slack + On-call email',
    );
  });
  test('signals with no target have no target clause', () => {
    expect(ruleSentence({ signal: 'build-failed', selector: {}, threshold: null, forSeconds: 60, channelIds: [] }, channels)).toBe(
      'When a build fails → every channel',
    );
  });
  test('no channels at all', () => {
    expect(ruleSentence({ signal: 'queue-depth', selector: {}, threshold: 1000, forSeconds: 0, channelIds: [] }, [])).toBe(
      'When waiting jobs in any app is above 1,000 jobs → nowhere yet',
    );
  });
  test('every phrase agrees with the catalogue target kind', () => {
    expect(phraseTargetsAgree()).toBe(true);
  });
});

describe('several rules per signal', () => {
  const any = rule({ id: 'any' });
  const shop = rule({ id: 'shop', isDefault: false, selector: { app: 'storefront' } });
  test('a ruleless event goes to the first enabled rule whose target covers it', () => {
    expect(ruleForEvent([shop, any], 'error-rate', 'service:storefront_checkout')?.id).toBe('shop');
    expect(ruleForEvent([shop, any], 'error-rate', 'service:blog_web')?.id).toBe('any');
    expect(ruleForEvent([{ ...shop, enabled: false }], 'error-rate', 'service:storefront_web')).toBeUndefined();
  });
  test('resource names read as app / part or server', () => {
    expect(resourceName('service:storefront_checkout')).toBe('storefront / checkout');
    expect(resourceName('node:wkr-2')).toBe('wkr-2');
    expect(resourceName('backup:data_pgdata')).toBe('data_pgdata');
  });
  test('mute is a moment in time', () => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    expect(isMuted({ mutedUntil: '2026-09-26T11:00:00Z' }, now)).toBe(true);
    expect(isMuted({ mutedUntil: '2026-09-26T09:00:00Z' }, now)).toBe(false);
    expect(isMuted({ mutedUntil: null }, now)).toBe(false);
  });
});
