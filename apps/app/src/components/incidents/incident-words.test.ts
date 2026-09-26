import { describe, expect, test } from 'bun:test';
import { partWords, plainWords, resourceWords, splitServiceName, versionOf, type WordsContext } from './incident-words';

const ctx: WordsContext = {
  serviceApp: new Map([
    ['checkout', 'storefront'],
    ['postgres', 'data'],
  ]),
  apps: ['storefront', 'data', 'platform'],
  versions: new Map([['rel-store-6', '1.9.0']]),
};

describe('service names', () => {
  test('a stack-prefixed name splits on the known app', () => {
    expect(splitServiceName('storefront_checkout', ctx)).toEqual({ app: 'storefront', part: 'checkout' });
    expect(partWords('storefront_checkout', ctx)).toBe('checkout in storefront');
  });

  test('a short name finds its app in the inventory', () => {
    expect(partWords('checkout', ctx)).toBe('checkout in storefront');
  });

  test('an unknown name stays as it is', () => {
    expect(partWords('mystery', ctx)).toBe('mystery');
  });
});

describe('resourceWords', () => {
  test('every key shape reads plainly', () => {
    expect(resourceWords('service:storefront_checkout', ctx)).toBe('checkout in storefront');
    expect(resourceWords('release:storefront', ctx)).toBe('the storefront rollout');
    expect(resourceWords('db:main-db', ctx)).toBe('the main-db database');
    expect(resourceWords('node:wkr-3', ctx)).toBe('server wkr-3');
    expect(resourceWords('alert:service:checkout', ctx)).toBe('checkout in storefront');
  });
});

describe('plainWords', () => {
  test('the copies-short alert event', () => {
    expect(
      plainWords('replicas on service:checkout — 1 of 2 running since release rel-store-6 (1.9.0) began its canary', ctx),
    ).toBe('copies of checkout in storefront — 1 of 2 running since 1.9.0 began its trial run');
  });

  test('a signal prefix before a full sentence is dropped', () => {
    expect(plainWords('error-rate on service:storefront_checkout — Error rate on storefront_checkout is 6.2% over 5m (41/662 spans)', ctx)).toBe(
      'Error rate on checkout in storefront is 6.2% over 5m (41 of 662 requests)',
    );
  });

  test('the opened event names what it is for', () => {
    expect(plainWords('Incident opened (release:storefront)', ctx)).toBe('Incident opened for the storefront rollout');
  });

  test('alert messages lose the Docker service name and the span jargon', () => {
    expect(plainWords('Error rate on storefront_checkout is 6.2% over 5m (41/662 spans)', ctx)).toBe(
      'Error rate on checkout in storefront is 6.2% over 5m (41 of 662 requests)',
    );
    expect(plainWords('storefront_checkout is running 1 of 2 copies', ctx)).toBe('checkout in storefront is running 1 of 2 copies');
  });

  test('a bare release id becomes its version, or a plain phrase', () => {
    expect(plainWords('rolled out rel-store-6', ctx)).toBe('rolled out 1.9.0');
    expect(plainWords('rolled out rel-other-1', ctx)).toBe('rolled out a new version');
  });

  test('plain text is left alone', () => {
    const s = 'Some checkouts are slower than usual. We are on it.';
    expect(plainWords(s, ctx)).toBe(s);
    expect(plainWords(plainWords('Incident opened (release:storefront)', ctx), ctx)).toBe('Incident opened for the storefront rollout');
  });
});

describe('versionOf', () => {
  test('the first image tag', () => {
    expect(versionOf([{ image: 'ghcr.io/northwind/web:1.9.0' }])).toBe('1.9.0');
    expect(versionOf([{ image: 'ghcr.io/northwind/web@sha256:abc' }])).toBeNull();
    expect(versionOf([])).toBeNull();
  });
});
