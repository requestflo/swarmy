/**
 * Grouping goldens. The first block pins the hash + components for the real
 * @sentry/node events in __fixtures__ — a change here SPLITS or MERGES every
 * existing issue in every install, so only update a golden on purpose.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decodeBody, itemJson, parseEnvelope } from './envelope';
import { messageTemplate, normalizeEvent, type NormalizedEvent, type SentryFrame } from './event';
import { cleanFilename, cleanFunction, computeGrouping, parametrize } from './grouping';
import { parseSourceMap, symbolicateFrame } from './sourcemap';

function fixtureEvent(name: string): { raw: Record<string, unknown>; ev: NormalizedEvent } {
  const body = decodeBody(new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))), null);
  const raw = itemJson(parseEnvelope(body).items[0]!)!;
  return { raw, ev: normalizeEvent(raw, { now: 0 }) };
}
const group = (name: string) => {
  const { raw, ev } = fixtureEvent(name);
  return computeGrouping(ev, messageTemplate(raw));
};

describe('goldens — real @sentry/node 11 events', () => {
  test('exception from the minified bundle (unsymbolicated)', () => {
    expect(group('node-exception-minified.envelope')).toMatchInlineSnapshot(`
      {
        "components": [
          "type:TypeError",
          "frame:capture|~try { runCheckout(); } catch (e) { Sentry.captureException(e); }",
          "frame:out:checkout.min|u",
          "frame:out:checkout.min|e",
          "frame:out:checkout.min|n",
        ],
        "hash": "b2fc8f13f55618a47631dc5afefc499f",
        "variant": "exception-in-app",
      }
    `);
  });

  test('the same exception after source-map resolution groups on original names', () => {
    const { raw, ev } = fixtureEvent('node-exception-minified.envelope');
    const map = parseSourceMap(readFileSync(new URL('./__fixtures__/checkout.min.js.map', import.meta.url), 'utf8'));
    const frames = ev.exceptions[0]!.stacktrace!.frames!;
    ev.exceptions[0]!.stacktrace!.frames = frames.map((f: SentryFrame) =>
      f.filename?.endsWith('checkout.min.js') ? symbolicateFrame(f, map, '~/out/checkout.min.js.map') : f,
    );
    expect(computeGrouping(ev, messageTemplate(raw))).toMatchInlineSnapshot(`
      {
        "components": [
          "type:TypeError",
          "frame:capture|~try { runCheckout(); } catch (e) { Sentry.captureException(e); }",
          "frame:src/checkout.js|runCheckout",
          "frame:src/checkout.js|computeTotal",
          "frame:src/checkout.js|priceOf",
        ],
        "hash": "8cce9dff0a60bc844663ffca12c43a18",
        "variant": "exception-in-app",
      }
    `);
  });

  test('captureMessage (synthetic exception: type/value ignored, stack used)', () => {
    expect(group('node-message.envelope')).toMatchInlineSnapshot(`
      {
        "components": [
          "frame:capture|~Sentry.captureMessage('Payment provider slow: %s', 'warning');",
        ],
        "hash": "a9f1359f2aa06e69ae46eba8eb59c806",
        "variant": "exception-in-app",
      }
    `);
  });

  test('chained cause + SDK fingerprint ["{{ default }}", "config"]', () => {
    expect(group('node-chained-fingerprint.envelope')).toMatchInlineSnapshot(`
      {
        "components": [
          "type:SyntaxError",
          "frame:capture|~try { JSON.parse('{nope'); } catch (inner) { throw new Error('config load failed', { cause: inner }); }",
          "type:Error",
          "frame:capture|~try { JSON.parse('{nope'); } catch (inner) { throw new Error('config load failed', { cause: inner }); }",
          "fp:config",
        ],
        "hash": "02c809b7a3710ada13758208ce3505da",
        "variant": "custom",
      }
    `);
  });

  test('gzip-delivered event', () => {
    expect(group('node-large.envelope.gz')).toMatchInlineSnapshot(`
      {
        "components": [
          "type:RangeError",
          "frame:capture|~Sentry.withScope((scope) => {",
          "frame:capture|~Sentry.captureException(new RangeError('too big'));",
        ],
        "hash": "24d99dfb29a7c93dfdc34d2f44c13ced",
        "variant": "exception-in-app",
      }
    `);
  });
});

/* ------------------------------------------------------------------------- */

function browserEvent(frames: SentryFrame[], over: Partial<Record<string, unknown>> = {}): NormalizedEvent {
  return normalizeEvent(
    {
      platform: 'javascript',
      exception: { values: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'id')", stacktrace: { frames } }] },
      ...over,
    },
    { now: 0 },
  );
}
const f = (fn: string, file: string, line = 1, col = 1, inApp = true): SentryFrame => ({
  function: fn,
  filename: file,
  abs_path: file,
  lineno: line,
  colno: col,
  in_app: inApp,
});

describe('grouping rules', () => {
  const base = [f('dispatch', 'https://shop.example.com/assets/vendor.1a2b3c4d.js', 1, 900, false), f('loadUser', 'https://shop.example.com/assets/app.3f9a1c2e.js', 1, 120)];

  test('line/column moves and content-hash renames do not split an issue', () => {
    const a = computeGrouping(browserEvent(base));
    const b = computeGrouping(
      browserEvent([
        f('dispatch', 'https://shop.example.com/assets/vendor.99887766.js', 1, 950, false),
        f('loadUser', 'https://shop.example.com/assets/app.0badf00d.js?v=2', 3, 7),
      ]),
    );
    expect(b.hash).toBe(a.hash);
    expect(a.variant).toBe('exception-in-app');
    expect(a.components).toEqual(['type:TypeError', 'frame:/assets/app.<hash>.js|loadUser']);
  });

  test('a different in-app function is a different issue; system frames alone do not matter', () => {
    const a = computeGrouping(browserEvent(base));
    const other = computeGrouping(browserEvent([base[0]!, f('loadCart', 'https://shop.example.com/assets/app.3f9a1c2e.js')]));
    const sysOnlyDiff = computeGrouping(browserEvent([f('flush', 'https://shop.example.com/assets/vendor.1a2b3c4d.js', 1, 1, false), base[1]!]));
    expect(other.hash).not.toBe(a.hash);
    expect(sysOnlyDiff.hash).toBe(a.hash);
  });

  test('no in-app frames → system variant over every frame', () => {
    const g = computeGrouping(browserEvent([f('a', 'x.js', 1, 1, false), f('b', 'y.js', 1, 1, false)]));
    expect(g.variant).toBe('exception-system');
    expect(g.components).toEqual(['type:TypeError', 'frame:x.js|a', 'frame:y.js|b']);
  });

  test('no stack → type + parametrised value', () => {
    const g1 = computeGrouping(normalizeEvent({ exception: { values: [{ type: 'NotFound', value: 'user 41 missing' }] } }, { now: 0 }));
    const g2 = computeGrouping(normalizeEvent({ exception: { values: [{ type: 'NotFound', value: 'user 42 missing' }] } }, { now: 0 }));
    expect(g1.variant).toBe('exception-no-stack');
    expect(g1.hash).toBe(g2.hash);
  });

  test('message events group on the template, not the formatted text', () => {
    const a = normalizeEvent({ logentry: { message: 'order %s failed', formatted: 'order 1 failed' } }, { now: 0 });
    const b = normalizeEvent({ logentry: { message: 'order %s failed', formatted: 'order 2 failed' } }, { now: 0 });
    expect(computeGrouping(a, 'order %s failed').hash).toBe(computeGrouping(b, 'order %s failed').hash);
    expect(computeGrouping(a, 'order %s failed').variant).toBe('message');
  });

  test('custom fingerprint replaces default; {{ default }} alone is the default', () => {
    const def = computeGrouping(browserEvent(base));
    const onlyDefault = computeGrouping(browserEvent(base, { fingerprint: ['{{ default }}'] }));
    const custom = computeGrouping(browserEvent(base, { fingerprint: ['database-unavailable'] }));
    const custom2 = computeGrouping(browserEvent([f('other', 'z.js')], { fingerprint: ['database-unavailable'] }));
    expect(onlyDefault.hash).toBe(def.hash);
    expect(custom.variant).toBe('custom');
    expect(custom.hash).toBe(custom2.hash);
    expect(custom.hash).not.toBe(def.hash);
    const tx = computeGrouping(browserEvent(base, { fingerprint: ['{{ transaction }}', 'x'], transaction: '/checkout' }));
    expect(tx.components).toEqual(['transaction:/checkout', 'fp:x']);
  });

  test('direct recursion collapses', () => {
    const r = computeGrouping(browserEvent([f('walk', 'a.js'), f('walk', 'a.js'), f('walk', 'a.js'), f('visit', 'a.js')]));
    expect(r.components).toEqual(['type:TypeError', 'frame:a.js|walk', 'frame:a.js|visit']);
  });

  test('hash is 32 hex chars', () => {
    expect(computeGrouping(browserEvent(base)).hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('normalisers', () => {
  test('cleanFilename', () => {
    expect(cleanFilename('webpack:///./src/app.ts')).toBe('/./src/app.ts');
    expect(cleanFilename('https://x.com/static/js/main.8e3a9f1b.chunk.js?x=1#y')).toBe('/static/js/main.<hash>.chunk.js');
    expect(cleanFilename('/srv/app/node_modules/express/lib/router.js')).toBe('node_modules/express/lib/router.js');
    expect(cleanFilename('~/dist/a.js')).toBe('/dist/a.js');
  });
  test('cleanFunction', () => {
    expect(cleanFunction('async Object.handler')).toBe('handler');
    expect(cleanFunction('new Foo')).toBe('Foo');
    expect(cleanFunction('Router.handle [as handle_request]')).toBe('Router.handle');
    expect(cleanFunction('Server.<anonymous>')).toBeNull();
    expect(cleanFunction('?')).toBeNull();
  });
  test('parametrize', () => {
    expect(parametrize('user 42 at 10.0.0.1 id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 mail a@b.io 0xdeadbeef on 2026-09-24T10:00:00Z')).toBe(
      'user <int> at <ip> id <uuid> mail <email> <hex> on <date>',
    );
  });
});
