import { expect, test } from 'bun:test';
import { MIB } from '@/components/service-settings/settings-model';
import { sizeDraft, sizeOf, sizeSentence, sizeWords, sizeYaml, tooSmall } from './size-model';

const usage = (peakMb: number) => ({ sampled: 2, cpuCores: { avg: 0.1, peak: 0.2 }, memBytes: { avg: peakMb * MIB, peak: peakMb * MIB }, ts: 0 });

test('sizeOf matches a preset exactly, never approximately', () => {
  expect(sizeOf({ cpus: 0.5, memoryBytes: 512 * MIB })).toBe('small');
  expect(sizeOf({ cpus: 0.5, memoryBytes: 768 * MIB })).toBeNull();
  expect(sizeOf({ cpus: 0.5 })).toBeNull();
  expect(sizeOf(undefined)).toBeNull();
});

test('sizeDraft sets both limits', () => {
  expect(sizeDraft('medium')).toEqual({ cpuLimit: 1, memLimit: 1024 * MIB });
});

test('words and the sentence', () => {
  expect(sizeWords({ cpus: 0.5, memoryBytes: 512 * MIB })).toBe('0.5 CPU · 512 MB');
  expect(sizeWords({ memoryBytes: 2048 * MIB })).toBe('2 GB');
  expect(sizeWords(undefined)).toBe('no ceiling');
  expect(sizeSentence({ cpus: 0.5, memoryBytes: 512 * MIB }, usage(311))).toBe('Each copy can use up to 0.5 CPU · 512 MB (small). The busiest uses 311 MB now.');
  expect(sizeSentence({}, null)).toBe('No ceiling: each copy can use as much of its server as it likes.');
});

test('tooSmall compares against the busiest copy now', () => {
  expect(tooSmall('nano', usage(311))).toBe(true);
  expect(tooSmall('small', usage(311))).toBe(false);
  expect(tooSmall('nano', null)).toBe(false);
});

test('sizeYaml uses the size key for presets, cpu/memory otherwise', () => {
  expect(sizeYaml({ cpus: 1, memoryBytes: 1024 * MIB })).toEqual({ size: 'medium' });
  expect(sizeYaml({ cpus: 0.5, memoryBytes: 768 * MIB })).toEqual({ cpu: 0.5, memory: '768mb' });
  expect(sizeYaml(undefined)).toEqual({});
});
