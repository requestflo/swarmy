/**
 * Source-map resolution against a real `bun build --minify --sourcemap`
 * bundle and the real @sentry/node event that crashed inside it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseEnvelope, itemJson } from './envelope';
import { exceptionValues } from './event';
import {
  artifactPath,
  enclosingFunctionName,
  matchArtifact,
  originalPositionFor,
  parseSourceMap,
  resolveMapName,
  sourceMappingUrl,
  symbolicateFrame,
} from './sourcemap';

const read = (n: string) => readFileSync(new URL(`./__fixtures__/${n}`, import.meta.url), 'utf8');
const mapText = read('checkout.min.js.map');
const minified = read('checkout.min.js');

describe('parseSourceMap + originalPositionFor', () => {
  const map = parseSourceMap(mapText);
  test('sources and content survive', () => {
    expect(map.sources).toEqual(['../src/checkout.js']);
    expect(map.sourcesContent[0]).toContain('function priceOf(item)');
  });
  test('the throw site maps back to line 10 of the original', () => {
    // `throw TypeError(` in the minified file: frame `n` at 1:101 in the Sentry event.
    const p = originalPositionFor(map, 1, 101)!;
    expect(p.source).toBe('../src/checkout.js');
    expect(p.line).toBe(10);
  });
  test('out-of-range lines resolve to null', () => {
    expect(originalPositionFor(map, 99, 1)).toBeNull();
  });
  test('index maps (sections) offset their mappings', () => {
    const idx = parseSourceMap({
      version: 3,
      sections: [{ offset: { line: 2, column: 0 }, map: JSON.parse(mapText) }],
    });
    expect(originalPositionFor(idx, 3, 101)!.line).toBe(10);
    expect(originalPositionFor(idx, 1, 101)).toBeNull();
  });
  test('rejects garbage', () => {
    expect(() => parseSourceMap('{')).toThrow();
    expect(() => parseSourceMap({ version: 3, mappings: 'A$' })).toThrow();
  });
});

describe('enclosingFunctionName', () => {
  const src = JSON.parse(mapText).sourcesContent[0] as string;
  test('finds the declaration whose body is still open', () => {
    expect(enclosingFunctionName(src, 10)).toBe('priceOf');
    expect(enclosingFunctionName(src, 4)).toBe('computeTotal');
    expect(enclosingFunctionName(src, 15)).toBe('runCheckout');
  });
  test('arrow functions, methods and closed siblings', () => {
    const code = ['const a = () => {', '  return 1;', '};', 'const handler = async (req) => {', '  if (x) {', '    boom();', '  }', '};', 'class K {', '  save(input) {', '    fail();', '  }', '}'].join('\n');
    expect(enclosingFunctionName(code, 6)).toBe('handler');
    expect(enclosingFunctionName(code, 11)).toBe('save');
  });
});

describe('artifact matching', () => {
  const names = ['~/out/checkout.min.js', '~/out/checkout.min.js.map', '~/vendor.js', 'https://cdn.example.com/static/app.js'];
  test('longest suffix wins across absolute paths and URLs', () => {
    expect(matchArtifact('/srv/app/out/checkout.min.js', names)).toBe('~/out/checkout.min.js');
    expect(matchArtifact('https://shop.example.com/out/checkout.min.js?v=3', names)).toBe('~/out/checkout.min.js');
    expect(matchArtifact('app:///static/app.js', names)).toBe('https://cdn.example.com/static/app.js');
    expect(matchArtifact('/srv/app/out/xcheckout.min.js', names)).toBeNull();
  });
  test('sourceMappingURL + relative resolution', () => {
    expect(sourceMappingUrl(minified)).toBe('checkout.min.js.map');
    expect(resolveMapName('~/out/checkout.min.js', 'checkout.min.js.map')).toBe('~/out/checkout.min.js.map');
    expect(resolveMapName('~/a/b/c.js', '../maps/c.js.map')).toBe('~/a/maps/c.js.map');
    expect(artifactPath('~/out/x.js')).toBe('/out/x.js');
  });
});

describe('symbolicateFrame — the real crash', () => {
  const env = parseEnvelope(new Uint8Array(readFileSync(new URL('./__fixtures__/node-exception-minified.envelope', import.meta.url))));
  const frames = exceptionValues(itemJson(env.items[0]!)!)[0]!.stacktrace!.frames!;
  const map = parseSourceMap(mapText);
  const minFrames = frames.filter((f) => f.filename?.endsWith('checkout.min.js'));

  test('minified n/e/u become priceOf/computeTotal/runCheckout with context', () => {
    expect(minFrames.map((f) => f.function)).toEqual(['u', 'e', 'n']);
    const out = minFrames.map((f) => symbolicateFrame(f, map, '~/out/checkout.min.js.map'));
    expect(out.map((f) => [f.function, f.filename, f.lineno])).toEqual([
      ['runCheckout', 'src/checkout.js', 15],
      ['computeTotal', 'src/checkout.js', 4],
      ['priceOf', 'src/checkout.js', 10],
    ]);
    expect(out[2]!.context_line).toBe("    throw new TypeError(`Cannot read price of ${item.sku}`);");
    expect(out[2]!.pre_context).toHaveLength(5);
    expect(out[2]!.data?.minified).toEqual({ filename: '/srv/app/out/checkout.min.js', function: 'n', lineno: 1, colno: 101 });
    expect(out[2]!.in_app).toBe(true);
  });
});
