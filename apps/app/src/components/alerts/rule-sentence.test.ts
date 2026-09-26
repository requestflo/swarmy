import { describe, expect, test } from 'bun:test';
import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { governingRule, newRuleEffect, ruleSentence } from './rule-sentence';

const ch = (id: string, name: string): NotificationChannelView => ({
  id, name, kind: 'slack', enabled: true, target: 'hooks.slack.com', hasSecret: false, createdAt: '2026-09-01T00:00:00Z',
});
const rule = (over: Partial<AlertRuleView>): AlertRuleView => ({
  id: 'r', name: 'Error rate high', signal: 'error-rate', threshold: 5, forSeconds: 0, channelIds: [], enabled: true,
  isDefault: true, createdAt: '2026-09-01T00:00:00Z', ...over,
});

describe('ruleSentence', () => {
  const channels = [ch('a', '#ops Slack'), ch('b', 'On-call email')];
  test('threshold signal with a hold and one channel', () => {
    expect(ruleSentence({ signal: 'error-rate', threshold: 5, forSeconds: 300, channelIds: ['a'] }, channels)).toBe(
      'When error rate of any app is above 5% for 5 min → #ops Slack',
    );
  });
  test('event signal ignores the hold and routes to every channel', () => {
    expect(ruleSentence({ signal: 'build-failed', threshold: null, forSeconds: 60, channelIds: [] }, channels)).toBe(
      'When a build fails → every channel',
    );
  });
  test('level signal without a threshold keeps its hold', () => {
    expect(ruleSentence({ signal: 'node-offline', threshold: null, forSeconds: 300, channelIds: ['a', 'b'] }, channels)).toBe(
      'When a server stops checking in for 5 min → #ops Slack + On-call email',
    );
  });
  test('no channels at all', () => {
    expect(ruleSentence({ signal: 'queue-depth', threshold: 1000, forSeconds: 0, channelIds: [] }, [])).toBe(
      'When waiting jobs in any queue is above 1,000 jobs → nowhere yet',
    );
  });
});

describe('governingRule', () => {
  const builtIn = rule({ id: 'd' });
  const older = rule({ id: 'c1', isDefault: false, createdAt: '2026-09-10T00:00:00Z' });
  const newer = rule({ id: 'c2', isDefault: false, createdAt: '2026-09-20T00:00:00Z' });
  test('the oldest custom rule beats the built-in one', () => {
    expect(governingRule([builtIn, newer, older], 'error-rate')?.id).toBe('c1');
  });
  test('a new rule replaces a built-in, but is shadowed by an existing custom one', () => {
    expect(newRuleEffect([builtIn], 'error-rate').kind).toBe('replaces');
    expect(newRuleEffect([builtIn, older], 'error-rate').kind).toBe('shadowed');
    expect(newRuleEffect([builtIn], 'disk-usage').kind).toBe('fresh');
  });
});
