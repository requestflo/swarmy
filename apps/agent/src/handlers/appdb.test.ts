import { describe, expect, it } from 'bun:test';
import { demuxDockerStream } from './appdb';

function frame(type: number, s: string): Buffer {
  const payload = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

describe('demuxDockerStream (exec probe output)', () => {
  it('splits stdout and stderr frames in order', () => {
    const buf = Buffer.concat([frame(1, 'SWARMY_DB_USER=root\n'), frame(2, 'warn\n'), frame(1, 'SWARMY_PROBE_OK=1\n')]);
    expect(demuxDockerStream(buf)).toEqual({
      stdout: 'SWARMY_DB_USER=root\nSWARMY_PROBE_OK=1\n',
      stderr: 'warn\n',
    });
  });

  it('keeps a payload that spans bytes which look like a header', () => {
    const buf = frame(1, '\u0001\u0000\u0000\u0000pw');
    expect(demuxDockerStream(buf).stdout).toBe('\u0001\u0000\u0000\u0000pw');
  });

  it('treats an unframed (TTY) buffer as plain stdout', () => {
    expect(demuxDockerStream(Buffer.from('hello world\n'))).toEqual({ stdout: 'hello world\n', stderr: '' });
  });
});
