import { describe, expect, test } from 'bun:test';
import { changeWords, configName, countWords, docLabel, sizeWords } from './cluster-config-words';

describe('cluster config words', () => {
  test('names a document by what it is, plus its own name when it has one', () => {
    expect(docLabel('bkp-target', 'offsite')).toBe('Backup destination “offsite”');
    expect(docLabel('ingress', null)).toBe('Front door settings');
    expect(docLabel('newthing', null)).toBe('newthing');
  });

  test('the tech line is the real Docker config name', () => {
    expect(configName('stack', 'c123', 4)).toBe('swarmy-kv.stack.c123.v4');
  });

  test('sizes read against the limit', () => {
    expect(sizeWords(2048, 64 * 1024)).toBe('2.0 KB of 64.0 KB');
  });

  test('a put-back says which fields change', () => {
    expect(changeWords([])).toBe('Same settings as now');
    expect(changeWords(['bucket', 'enabled'])).toBe('Changes bucket, enabled');
    expect(changeWords(['a', 'b', 'c', 'd', 'e'])).toBe('Changes a, b, c and 2 more');
  });

  test('counts documents and versions', () => {
    expect(countWords([{ versions: [1, 2, 3] }, { versions: [1] }])).toBe('2 documents · 4 versions kept');
    expect(countWords([{ versions: [1] }])).toBe('1 document · 1 version kept');
  });
});
