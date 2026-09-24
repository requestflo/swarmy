import { describe, expect, test } from 'bun:test';
import { parseDotenv } from '../dotenv';
import { ComposeInterpolationError, interpolateCompose, interpolateString } from './interpolate';

const vars = { TAG: '1.2', EMPTY: '', PORT: '8080', NAME: 'web' };
const run = (s: string) => interpolateString(s, vars);

/** Golden table: input → expected, docker compose semantics. */
const GOLDEN: Array<[string, string]> = [
  ['nginx:${TAG}', 'nginx:1.2'],
  ['nginx:$TAG', 'nginx:1.2'],
  ['$NAME-$PORT', 'web-8080'],
  ['${NAME}_suffix', 'web_suffix'],
  ['$NAME_suffix', ''], // `$NAME_suffix` is the variable NAME_suffix (unset)
  ['${MISSING}', ''],
  ['${MISSING:-fallback}', 'fallback'],
  ['${EMPTY:-fallback}', 'fallback'],
  ['${TAG:-fallback}', '1.2'],
  ['${MISSING-fallback}', 'fallback'],
  ['${EMPTY-fallback}', ''],
  ['${MISSING:-}', ''],
  ['${MISSING:-${TAG}}', '1.2'],
  ['${MISSING:-${ALSO_MISSING:-deep}}', 'deep'],
  ['${TAG:+set}', 'set'],
  ['${EMPTY:+set}', ''],
  ['${EMPTY+set}', 'set'],
  ['${MISSING+set}', ''],
  ['${TAG:?must be set}', '1.2'],
  ['${EMPTY?only unset fails}', ''],
  ['${MISSING:-a b:c/d}', 'a b:c/d'],
  // `$$` is a literal `$` — never interpolated.
  ['$$', '$'],
  ['$$TAG', '$TAG'],
  ['$${TAG}', '${TAG}'],
  ['echo $$HOME && echo $TAG', 'echo $HOME && echo 1.2'],
  ['cost: $$5', 'cost: $5'],
  ['$$$TAG', '$1.2'],
  ['${MISSING:-$$literal}', '$literal'],
  ['no vars here', 'no vars here'],
];

describe('interpolateString (golden)', () => {
  for (const [input, want] of GOLDEN) {
    test(JSON.stringify(input), () => expect(run(input)).toBe(want));
  }
});

describe('interpolateString errors', () => {
  test('${VAR:?err} fails on unset and on empty, with the message', () => {
    expect(() => run('${MISSING:?set MISSING in the stack .env}')).toThrow(
      'required variable MISSING is missing a value: set MISSING in the stack .env',
    );
    expect(() => run('${EMPTY:?nope}')).toThrow('required variable EMPTY');
  });
  test('${VAR?err} fails only on unset', () => {
    expect(() => run('${MISSING?gone}')).toThrow('gone');
  });
  test.each(['$1', 'trailing $', 'a $ b', '${', '${TAG', '${1BAD}', '${TAG:x}', '${}'])(
    'invalid format %p throws',
    (s) => {
      expect(() => run(s)).toThrow(ComposeInterpolationError);
    },
  );
});

describe('interpolateCompose', () => {
  const doc = {
    services: {
      web: {
        image: 'ghcr.io/acme/web:${TAG:-latest}',
        ports: ['${PORT}:80'],
        environment: { GREETING: 'hi $$USER', API: '${API_URL}', RETRIES: 3 },
        command: ['sh', '-c', 'echo $$HOSTNAME'],
        '${NOT_A_KEY}': 'keys are left alone',
      },
    },
  };

  test('interpolates string values at every depth, not keys or non-strings; input untouched', () => {
    const before = JSON.stringify(doc);
    const { doc: out, warnings } = interpolateCompose(doc, { TAG: '2.0', PORT: '9000' });
    expect(out).toEqual({
      services: {
        web: {
          image: 'ghcr.io/acme/web:2.0',
          ports: ['9000:80'],
          environment: { GREETING: 'hi $USER', API: '', RETRIES: 3 },
          command: ['sh', '-c', 'echo $HOSTNAME'],
          '${NOT_A_KEY}': 'keys are left alone',
        },
      },
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(warnings).toEqual([
      {
        level: 'warn',
        path: 'services.web.environment.API',
        code: 'unset-variable',
        message: 'The "API_URL" variable is not set. Defaulting to a blank string.',
      },
    ]);
  });

  test('errors carry the value path', () => {
    try {
      interpolateCompose({ services: { db: { image: 'postgres:${PG:?pick a version}' } } }, {});
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ComposeInterpolationError);
      expect((e as ComposeInterpolationError).path).toBe('services.db.image');
      expect((e as Error).message).toBe('services.db.image: required variable PG is missing a value: pick a version');
    }
  });

  test('values come from a stack .env parsed by the bulk .env parser', () => {
    const env = Object.fromEntries(
      parseDotenv('TAG=3.1\n# comment\nexport PORT = 7000\nPRICE="$5"\n').entries.map((e) => [e.key, e.value]),
    );
    const { doc: out } = interpolateCompose({ image: 'x:${TAG}', port: '$PORT', price: '${PRICE}' }, env);
    // .env values are literal: a `$` inside one is NOT re-interpolated.
    expect(out).toEqual({ image: 'x:3.1', port: '7000', price: '$5' });
  });
});
