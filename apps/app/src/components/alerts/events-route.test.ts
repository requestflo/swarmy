import { describe, expect, test } from 'bun:test';
import { deliveries, flipRoute } from './events-route';

const live = ['email', 'slack', 'ntfy'];

describe('flipRoute', () => {
  test('unpicking one channel from All names the rest', () => {
    expect(flipRoute([], live, 'slack')).toEqual(['email', 'ntfy']);
  });
  test('picking one more channel adds it', () => {
    expect(flipRoute(['email'], live, 'slack')).toEqual(['email', 'slack']);
  });
  test('naming every enabled channel is All again', () => {
    expect(flipRoute(['email', 'ntfy'], live, 'slack')).toEqual([]);
  });
  test('unpicking the last one is All, never nowhere', () => {
    expect(flipRoute(['slack'], live, 'slack')).toEqual([]);
  });
});

test('deliveries counts every enabled channel for All, and only enabled picks', () => {
  const rules = [
    { enabled: true, channelIds: [] },
    { enabled: true, channelIds: ['slack', 'old-disabled'] },
    { enabled: false, channelIds: [] },
  ];
  expect(deliveries(rules, live)).toBe(4);
});
