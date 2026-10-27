/**
 * Binary-safe splitter for Docker's multiplexed (non-TTY) attach stream:
 * 8-byte frames `[type,0,0,0,size(u32 BE)]` + payload (1 = stdout, 2 = stderr).
 * Unlike `log-demux.ts` it hands back Buffers, never text, so a tar or a gzip
 * coming out of a sidecar arrives byte for byte. Frames straddle `data`
 * chunks, so the tail is buffered. Pure.
 */
export type FrameStream = 'stdout' | 'stderr';

export function createFrameDemuxer(emit: (stream: FrameStream, data: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const type = buf[0]!;
      const framed = (type === 0 || type === 1 || type === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
      if (!framed) throw new Error('docker attach stream lost frame sync');
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) return;
      const payload = buf.subarray(8, 8 + size);
      if (payload.length) emit(type === 2 ? 'stderr' : 'stdout', payload);
      buf = buf.subarray(8 + size);
    }
  };
}
