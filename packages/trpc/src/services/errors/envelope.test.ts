/**
 * Envelope parsing against REAL SDK payloads: every fixture in __fixtures__
 * was produced by @sentry/node 11.0.0 posting to a local capture endpoint
 * (`checkout.min.js` is a `bun build --minify --sourcemap` bundle the script
 * crashed inside). The only edit is the install path rewritten to /srv/app
 * (item headers carry no `length`, so the bytes stay valid).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deflateSync, gzipSync } from 'node:zlib';
import {
  decodeBody,
  EnvelopeError,
  itemJson,
  parseAuthHeader,
  parseDsnKey,
  parseEnvelope,
  parseStoreBody,
  rateLimitHeader,
  resolveAuth,
} from './envelope';

const fx = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));
const enc = (s: string) => new TextEncoder().encode(s);

describe('parseEnvelope — @sentry/node 11 payloads', () => {
  test('exception envelope: header + one event item', () => {
    const env = parseEnvelope(fx('node-exception-minified.envelope'));
    expect(env.header.event_id).toBe('a85a275618b544019a81c3173ff1e148');
    expect((env.header.sdk as { name: string }).name).toBe('sentry.javascript.node');
    expect((env.header.trace as { trace_id: string }).trace_id).toBe('e6d9a2c48eeb47b48f0f04df754d5bbc');
    expect(env.items.map((i) => i.header.type)).toEqual(['event']);
    const ev = itemJson(env.items[0]!)!;
    expect(ev.event_id).toBe('a85a275618b544019a81c3173ff1e148');
    expect(ev.release).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
  });

  test('session and span envelopes parse (dropped later, never an error)', () => {
    expect(parseEnvelope(fx('node-session.envelope')).items.map((i) => i.header.type)).toEqual(['session']);
    const span = parseEnvelope(fx('node-span.envelope'));
    expect(span.items[0]!.header.type).toBe('span');
    expect(span.items[0]!.header.content_type).toBe('application/vnd.sentry.items.span.v2+json');
  });

  test('gzip body (the Node transport compresses >32 KiB) decodes then parses', () => {
    const body = decodeBody(fx('node-large.envelope.gz'), 'gzip');
    const env = parseEnvelope(body);
    const ev = itemJson(env.items[0]!)!;
    expect((ev.extra as { blob: string }).blob.length).toBe(40000);
  });

  test('gzip without a Content-Encoding header is sniffed by magic bytes', () => {
    const env = parseEnvelope(decodeBody(fx('node-large.envelope.gz'), null));
    expect(env.items[0]!.header.type).toBe('event');
  });

  test('deflate and br', () => {
    const raw = fx('node-message.envelope');
    expect(parseEnvelope(decodeBody(new Uint8Array(deflateSync(raw)), 'deflate')).items).toHaveLength(1);
    const { brotliCompressSync } = require('node:zlib') as typeof import('node:zlib');
    expect(parseEnvelope(decodeBody(new Uint8Array(brotliCompressSync(raw)), 'br')).items).toHaveLength(1);
  });

  test('explicit length: payload may contain newlines; attachment + event in one envelope', () => {
    const att = 'line1\nline2';
    const body = enc(
      `{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc"}\n` +
        `{"type":"attachment","length":${enc(att).length},"filename":"a.txt"}\n${att}\n` +
        `{"type":"event","length":41}\n{"message":"hello","level":"info","x":1}\n`,
    );
    const env = parseEnvelope(body);
    expect(env.items.map((i) => i.header.type)).toEqual(['attachment', 'event']);
    expect(new TextDecoder().decode(env.items[0]!.payload)).toBe(att);
    expect(itemJson(env.items[1]!)!.message).toBe('hello');
  });

  test('length counts bytes, not characters (multi-byte UTF-8)', () => {
    const payload = '{"message":"héllo ✓"}';
    const body = enc(`{}\n{"type":"event","length":${enc(payload).length}}\n${payload}`);
    expect(itemJson(parseEnvelope(body).items[0]!)!.message).toBe('héllo ✓');
  });

  test('empty envelope (header only) and trailing blank lines', () => {
    expect(parseEnvelope(enc('{}\n')).items).toHaveLength(0);
    expect(parseEnvelope(enc('{}\n{"type":"event"}\n{"a":1}\n\n\n')).items).toHaveLength(1);
  });

  test('malformed input throws EnvelopeError', () => {
    expect(() => parseEnvelope(enc('not json\n'))).toThrow(EnvelopeError);
    expect(() => parseEnvelope(enc('{}\n{"length":2}\n{}'))).toThrow(EnvelopeError);
    expect(() => parseEnvelope(enc('{}\n{"type":"event","length":99}\n{}'))).toThrow(EnvelopeError);
    expect(() => decodeBody(enc('nope'), 'gzip')).toThrow(EnvelopeError);
    expect(() => decodeBody(enc('nope'), 'compress')).toThrow(EnvelopeError);
  });
});

describe('store body', () => {
  test('plain JSON and gzip', () => {
    const ev = { event_id: 'abc', message: 'x' };
    expect(parseStoreBody(enc(JSON.stringify(ev))).event_id).toBe('abc');
    expect(parseStoreBody(decodeBody(new Uint8Array(gzipSync(JSON.stringify(ev))), 'gzip')).message).toBe('x');
  });
  test('raven-era base64+zlib', () => {
    const b64 = deflateSync(JSON.stringify({ message: 'old' })).toString('base64');
    expect(parseStoreBody(enc(b64)).message).toBe('old');
  });
});

describe('auth', () => {
  test('X-Sentry-Auth header', () => {
    const h = parseAuthHeader('Sentry sentry_key=abc123, sentry_version=7, sentry_client=raven-python/6.0');
    expect(h).toEqual({ sentry_key: 'abc123', sentry_version: '7', sentry_client: 'raven-python/6.0' });
    expect(resolveAuth({ authHeader: 'Sentry sentry_key=abc123' }).publicKey).toBe('abc123');
  });
  test('query string (what @sentry/node and browser SDKs send)', () => {
    const q = new URLSearchParams('sentry_version=7&sentry_key=0123456789abcdef0123456789abcdef&sentry_client=sentry.javascript.node%2F11.0.0');
    expect(resolveAuth({ query: q })).toEqual({ publicKey: '0123456789abcdef0123456789abcdef', client: 'sentry.javascript.node/11.0.0' });
  });
  test('envelope dsn header (tunnel mode)', () => {
    expect(resolveAuth({ envelopeHeader: { dsn: 'https://k3y@swarmy.example.com/12345' } })).toEqual({ publicKey: 'k3y', dsnProjectId: '12345' });
    expect(parseDsnKey('https://k@h/not-a-number')).toBeNull();
  });
  test('nothing presented', () => {
    expect(resolveAuth({}).publicKey).toBeNull();
  });
  test('rate limit header shape', () => {
    expect(rateLimitHeader(59.2)).toBe('60::key');
    expect(rateLimitHeader(10, ['error', 'default'])).toBe('10:error;default:key');
  });
});
