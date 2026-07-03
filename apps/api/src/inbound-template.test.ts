import { describe, expect, test } from 'bun:test';
import {
  jsonAtPath,
  normalizeHeadersJson,
  renderInboundTemplate,
  stringifyTemplateValue,
  templateContentType,
  type InboundTemplateContext,
} from './inbound-template';

const ctx = (over: Partial<InboundTemplateContext> = {}): InboundTemplateContext => ({
  body: '{"event":"invoice.paid","amount":4900,"live":true,"meta":{"region":"eu"},"items":[{"sku":"A-1"}]}',
  headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
  slug: 'stripe-prod',
  deliveryId: 'idel-123',
  ...over,
});

describe('renderInboundTemplate', () => {
  test('substitutes body, slug and deliveryId', () => {
    expect(renderInboundTemplate('{{slug}}:{{deliveryId}}', ctx())).toBe('stripe-prod:idel-123');
    expect(renderInboundTemplate('{{body}}', ctx({ body: 'raw!' }))).toBe('raw!');
  });

  test('tolerates whitespace inside the braces', () => {
    expect(renderInboundTemplate('{{  slug  }}', ctx())).toBe('stripe-prod');
  });

  test('headers resolve case-insensitively against lowercase keys', () => {
    expect(renderInboundTemplate('{{headers.X-GitHub-Event}}', ctx())).toBe('push');
    expect(renderInboundTemplate('{{headers.content-type}}', ctx())).toBe('application/json');
  });

  test('missing headers are left verbatim', () => {
    expect(renderInboundTemplate('{{headers.x-nope}}', ctx())).toBe('{{headers.x-nope}}');
  });

  test('json dot paths: strings, numbers, booleans, nested, array index', () => {
    expect(renderInboundTemplate('{{json.event}}', ctx())).toBe('invoice.paid');
    expect(renderInboundTemplate('{{json.amount}}', ctx())).toBe('4900');
    expect(renderInboundTemplate('{{json.live}}', ctx())).toBe('true');
    expect(renderInboundTemplate('{{json.meta.region}}', ctx())).toBe('eu');
    expect(renderInboundTemplate('{{json.items.0.sku}}', ctx())).toBe('A-1');
  });

  test('json objects/arrays re-serialize; null renders as "null"', () => {
    expect(renderInboundTemplate('{{json.meta}}', ctx())).toBe('{"region":"eu"}');
    expect(renderInboundTemplate('{{json.x}}', ctx({ body: '{"x":null}' }))).toBe('null');
  });

  test('missing json paths and non-JSON bodies stay verbatim', () => {
    expect(renderInboundTemplate('{{json.missing.deep}}', ctx())).toBe('{{json.missing.deep}}');
    expect(renderInboundTemplate('{{json.a}}', ctx({ body: 'not json' }))).toBe('{{json.a}}');
    expect(renderInboundTemplate('{{json.items.nope}}', ctx())).toBe('{{json.items.nope}}');
  });

  test('unknown vars are left verbatim (typos stay visible)', () => {
    expect(renderInboundTemplate('{{nope}} {{body}}', ctx({ body: 'B' }))).toBe('{{nope}} B');
  });

  test('composes a full transform template', () => {
    const out = renderInboundTemplate(
      '{"source":"{{slug}}","id":"{{deliveryId}}","type":"{{json.event}}","raw":{{body}}}',
      ctx(),
    );
    expect(JSON.parse(out)).toMatchObject({ source: 'stripe-prod', id: 'idel-123', type: 'invoice.paid' });
  });
});

describe('jsonAtPath / stringifyTemplateValue', () => {
  test('array index must be an exact integer segment', () => {
    expect(jsonAtPath([1, 2], ['0'])).toBe(1);
    expect(jsonAtPath([1, 2], ['01'])).toBeUndefined();
    expect(jsonAtPath([1, 2], ['x'])).toBeUndefined();
  });

  test('descending into a scalar is undefined', () => {
    expect(jsonAtPath({ a: 'x' }, ['a', 'b'])).toBeUndefined();
  });

  test('stringify keeps strings raw and serializes structures', () => {
    expect(stringifyTemplateValue('s')).toBe('s');
    expect(stringifyTemplateValue(false)).toBe('false');
    expect(stringifyTemplateValue([1, 'a'])).toBe('[1,"a"]');
    expect(stringifyTemplateValue(undefined)).toBeUndefined();
  });
});

describe('normalizeHeadersJson', () => {
  test('lowercases keys and drops non-string values', () => {
    expect(normalizeHeadersJson({ 'X-One': 'a', bad: 42 })).toEqual({ 'x-one': 'a' });
    expect(normalizeHeadersJson(null)).toEqual({});
    expect(normalizeHeadersJson([1])).toEqual({});
  });
});

describe('templateContentType', () => {
  test('json bodies answer as application/json', () => {
    expect(templateContentType('{"ok":true}')).toBe('application/json; charset=utf-8');
    expect(templateContentType('thanks')).toBe('text/plain; charset=utf-8');
  });
});
