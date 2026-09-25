import { describe, expect, it } from 'bun:test';
import { createLogDemuxer, type LogStreamName } from './log-demux';

const frame = (type: number, s: string) => {
  const p = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(p.length, 4);
  return Buffer.concat([h, p]);
};
function run(chunks: Buffer[]) {
  const out: Array<[LogStreamName, string]> = [];
  const push = createLogDemuxer((s, t) => out.push([s, t]));
  for (const c of chunks) push(c);
  return out;
}

describe('service log demux (QA: logs carried Docker frame headers)', () => {
  it('strips frame headers and keeps stdout/stderr apart', () => {
    expect(run([Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')])])).toEqual([
      ['stdout', 'hello\n'],
      ['stderr', 'oops\n'],
    ]);
  });
  it('reassembles a frame split across chunks (header and payload)', () => {
    const all = Buffer.concat([frame(1, 'one line\n'), frame(1, 'two\n')]);
    const out = run([all.subarray(0, 3), all.subarray(3, 12), all.subarray(12)]);
    expect(out.map((x) => x[1]).join('')).toBe('one line\ntwo\n');
    expect(out.every(([s]) => s === 'stdout')).toBe(true);
  });
  it('passes a TTY (unframed) stream through as stdout', () => {
    expect(run([Buffer.from('plain tty output\n'), Buffer.from('more\n')])).toEqual([
      ['stdout', 'plain tty output\n'],
      ['stdout', 'more\n'],
    ]);
  });
});
