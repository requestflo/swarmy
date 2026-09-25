/**
 * Incremental splitter for Docker's multiplexed (non-TTY) log stream: 8-byte
 * frames `[type,0,0,0,size(u32 BE)]` + payload (1 = stdout, 2 = stderr). Frames
 * straddle `data` chunks, so the tail is buffered. A stream whose first bytes
 * are not a frame header (a TTY service) passes through untouched as stdout.
 */
export type LogStreamName = 'stdout' | 'stderr';

export function createLogDemuxer(emit: (stream: LogStreamName, text: string) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  let raw: boolean | null = null;
  return (chunk: Buffer) => {
    if (raw) return emit('stdout', chunk.toString('utf8'));
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const type = buf[0]!;
      const framed = (type === 0 || type === 1 || type === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
      if (!framed) {
        if (raw === null) {
          raw = true;
          emit('stdout', buf.toString('utf8'));
          buf = Buffer.alloc(0);
          return;
        }
        // Lost sync mid-stream: flush what is left rather than drop it.
        emit('stdout', buf.toString('utf8'));
        buf = Buffer.alloc(0);
        return;
      }
      raw = false;
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) return;
      const payload = buf.subarray(8, 8 + size);
      if (payload.length) emit(type === 2 ? 'stderr' : 'stdout', payload.toString('utf8'));
      buf = buf.subarray(8 + size);
    }
  };
}
