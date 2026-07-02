/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { diffLines, diffStats } from './line-diff';

const ops = (old: string, next: string): string =>
  diffLines(old, next)
    .map((l) => `${l.op === 'same' ? ' ' : l.op === 'add' ? '+' : '-'}${l.text}`)
    .join('|');

describe('diffLines', () => {
  it('identical texts are all same rows with aligned numbers', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines.map((l) => l.op)).toEqual(['same', 'same', 'same']);
    expect(lines[2]).toEqual({ op: 'same', text: 'c', oldLine: 3, newLine: 3 });
  });

  it('pure insertion and pure deletion', () => {
    expect(ops('a\nc', 'a\nb\nc')).toBe(' a|+b| c');
    expect(ops('a\nb\nc', 'a\nc')).toBe(' a|-b| c');
  });

  it('a changed line is a del + add pair', () => {
    expect(ops('a\nb\nc', 'a\nB\nc')).toBe(' a|-b|+B| c');
  });

  it('handles changes at both ends plus a common middle', () => {
    expect(ops('x\nkeep\ny', 'X\nkeep\nY')).toBe('-x|+X| keep|-y|+Y');
  });

  it('empty old = all adds; empty new = all dels; both empty = nothing', () => {
    expect(ops('', 'a\nb')).toBe('+a|+b');
    expect(ops('a\nb', '')).toBe('-a|-b');
    expect(diffLines('', '')).toEqual([]);
  });

  it('a trailing newline does not fabricate a phantom line', () => {
    expect(diffLines('a\nb\n', 'a\nb')).toEqual([
      { op: 'same', text: 'a', oldLine: 1, newLine: 1 },
      { op: 'same', text: 'b', oldLine: 2, newLine: 2 },
    ]);
  });

  it('carries 1-based old/new line numbers through mixed edits', () => {
    const lines = diffLines('one\ntwo\nthree', 'one\n2\ntwo\nthree');
    expect(lines).toEqual([
      { op: 'same', text: 'one', oldLine: 1, newLine: 1 },
      { op: 'add', text: '2', newLine: 2 },
      { op: 'same', text: 'two', oldLine: 2, newLine: 3 },
      { op: 'same', text: 'three', oldLine: 3, newLine: 4 },
    ]);
  });

  it('keeps a moved block coherent (LCS, not naive positional diff)', () => {
    expect(ops('a\nb\nc\nd', 'c\nd\na\nb')).toBe('-a|-b| c| d|+a|+b');
  });
});

describe('diffStats', () => {
  it('counts adds and removes', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nB\nc\nd'))).toEqual({ added: 2, removed: 1 });
    expect(diffStats(diffLines('same', 'same'))).toEqual({ added: 0, removed: 0 });
  });
});
