import { describe, expect, it } from 'bun:test';
import { buildOptions, draftSummary, kindChip, parseArgs, scannedLabel, toggleId, yamlRows } from './git-scan-model';
import type { Detection } from './git-scan-types';

const det = (over: Partial<Detection>): Detection => ({
  id: 'x',
  kind: 'postgres',
  name: 'db',
  maps: 'resources.db',
  label: 'Postgres',
  why: '',
  evidence: [{ file: 'package.json', line: 1, text: '"pg": "8"' }],
  ...over,
});

describe('git scan model', () => {
  it('says what was read, honestly', () => {
    expect(scannedLabel(9, 1834)).toBe('scanned 9 files · 1.8 s');
    expect(scannedLabel(1, 400)).toBe('scanned 1 file · 0.4 s');
  });

  it('sums up the draft from the graph toDesired drew', () => {
    const graph = {
      stack: 'orders',
      services: [{ name: 'web', meta: '', wires: [] }, { name: 'worker', meta: '', wires: [] }],
      data: [{ name: 'db', meta: '' }],
      jobs: [],
    };
    expect(draftSummary(graph, 'a\nb\nc\n')).toBe('Adds 2 services · 1 resource · 3 lines');
    expect(draftSummary(null, 'a\n')).toBe('1 line');
  });

  it('chips and ticks', () => {
    expect(kindChip(det({}))).toEqual({ word: 'postgres 16', tone: 'info' });
    expect(kindChip(det({ kind: 'cron', via: 'in-process' })).word).toBe('schedule');
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleId(['b'], 'a')).toEqual(['b', 'a']);
  });

  it('splits swarmy.yaml into key / value / comment rows', () => {
    const rows = yamlRows('# head\nservices:\n  web:\n    replicas: 1 # node-cron runs in-process\n    env: ${{ db.url }}\n');
    expect(rows.map((r) => [r.no, r.indent.length, r.key, r.value, r.comment])).toEqual([
      [1, 0, '', '', '# head'],
      [2, 0, 'services', '', ''],
      [3, 2, 'web', '', ''],
      [4, 4, 'replicas', '1', '# node-cron runs in-process'],
      [5, 4, 'env', '${{ db.url }}', ''],
    ]);
  });

  it('maps the Build · advanced fields to build: keys, blank = default', () => {
    expect(parseArgs('NODE_ENV=production, APP_VERSION = 2\njunk')).toEqual({ NODE_ENV: 'production', APP_VERSION: '2' });
    expect(buildOptions({ path: '', dockerfile: ' Dockerfile ', target: 'runtime', args: '', watch: 'services/orders, packages/shared' })).toEqual({
      dockerfile: 'Dockerfile',
      target: 'runtime',
      watch: ['services/orders', 'packages/shared'],
    });
  });
});
