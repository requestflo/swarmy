import { describe, expect, test } from 'bun:test';
import { isWarningLine, lineTone, parseBuildLayers, toLogLines } from './build-log-parse';

const PLAIN = [
  '#1 [internal] load build definition from Dockerfile',
  '#1 transferring dockerfile: 412B done',
  '#1 DONE 0.0s',
  '#2 [auth] library/node:pull token for registry-1.docker.io',
  '#2 DONE 0.0s',
  '#3 [base 1/2] FROM docker.io/library/node:22-alpine@sha256:9f3c',
  '#3 resolve docker.io/library/node:22-alpine@sha256:9f3c done',
  '#3 CACHED',
  '#4 [deps 1/1] RUN pnpm install --frozen-lockfile',
  '#5 [build 1/2] COPY . .',
  '#4 CACHED',
  '#5 DONE 0.4s',
  '#6 [build 2/2] RUN pnpm build',
  '#6 9.870 (!) Some chunks are larger than 500 kB after minification.',
  '#6 ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1',
  '#7 [runtime 1/1] COPY --from=build /app/dist ./dist',
  '#7 CANCELED',
  '#8 exporting to image',
  '#8 DONE 1.2s',
].join('\n');

describe('parseBuildLayers', () => {
  test('keeps Dockerfile steps with their outcome, drops BuildKit bookkeeping', () => {
    expect(parseBuildLayers(PLAIN).map((l) => [l.id, l.stage, l.instruction, l.status, l.seconds])).toEqual([
      [3, 'base 1/2', 'FROM docker.io/library/node:22-alpine@sha256:9f3c', 'cached', null],
      [4, 'deps 1/1', 'RUN pnpm install --frozen-lockfile', 'cached', null],
      [5, 'build 1/2', 'COPY . .', 'done', 0.4],
      [6, 'build 2/2', 'RUN pnpm build', 'error', null],
      [7, 'runtime 1/1', 'COPY --from=build /app/dist ./dist', 'canceled', null],
    ]);
  });
  test('a step without an outcome yet is still running; non-BuildKit text is ignored', () => {
    const layers = parseBuildLayers("Cloning into '/work'...\n#4 [2/3] RUN npm ci\n#4 0.512 added 318 packages");
    expect(layers).toEqual([{ id: 4, stage: '2/3', instruction: 'RUN npm ci', status: 'running', seconds: null }]);
  });
});

describe('toLogLines', () => {
  test('splits multi-line chunks and drops the closing newline', () => {
    const lines = toLogLines([
      { seq: 0, stream: 'stderr', message: '#4 [deps 1/1] RUN pnpm install\n#4 CACHED\n' },
      { seq: 1, stream: 'stdout', message: 'SWARMY done' },
      { seq: 2, stream: 'stdout', message: '\n' },
    ]);
    expect(lines.map((l) => [l.stream, l.text])).toEqual([
      ['stderr', '#4 [deps 1/1] RUN pnpm install'],
      ['stderr', '#4 CACHED'],
      ['stdout', 'SWARMY done'],
      ['stdout', ''],
    ]);
  });
});

describe('isWarningLine', () => {
  const yes = [
    '#6 9.870 (!) Some chunks are larger than 500 kB',
    ' 1 warning found (use docker --debug to expand):',
    'WARN: FromAsCasing: as and FROM keywords do not match',
    'npm warn deprecated inflight@1.0.6',
    '#6 ERROR: process "/bin/sh -c pnpm build" did not complete successfully',
    'error: command "bun run build" exited with code 1',
    "#11 6.511 src/index.ts(42,7): error TS2345: Argument of type 'string' is not assignable",
    "fatal: repository 'https://github.com/northwind/web.git/' not found",
  ];
  const no = ['#5 [build 1/2] COPY src/error-boundary.tsx .', '#5 DONE 0.4s', '#4 CACHED'];
  for (const l of yes) test(`flags: ${l}`, () => expect(isWarningLine(l)).toBe(true));
  for (const l of no) test(`passes: ${l}`, () => expect(isWarningLine(l)).toBe(false));
  test('errors read bad, warnings warn', () => {
    expect(['npm warn deprecated glob@7', '#6 ERROR: exit code: 1', '#4 CACHED'].map((l) => lineTone(l))).toEqual(['warn', 'bad', null]);
  });
});
