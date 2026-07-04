import { encodeForTcp } from '@swarmy/dns';
import { log } from './config';
import { handleQuery, type QueryContext } from './query';

/**
 * DNS over TCP (RFC 1035 §4.2.2): each message is prefixed with a 2-byte
 * big-endian length. Required for large answers (TC retries), `dig +tcp`,
 * and many delegation checkers. We buffer per connection and answer every
 * complete frame; pipelined queries are fine.
 */
interface TcpState {
  buffer: Buffer;
}

const MAX_TCP_MESSAGE = 4096; // sanity cap — our answers are far smaller
const IDLE_TIMEOUT_S = 10;

export function startTcpServer(
  ctx: QueryContext,
  host: string,
  port: number,
): { close(): void } {
  const server = Bun.listen<TcpState>({
    hostname: host,
    port,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0) };
        socket.timeout(IDLE_TIMEOUT_S);
      },
      data(socket, chunk) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, chunk]);
        for (;;) {
          const buf = socket.data.buffer;
          if (buf.byteLength < 2) return;
          const messageLength = buf.readUInt16BE(0);
          if (messageLength > MAX_TCP_MESSAGE) {
            socket.end();
            return;
          }
          if (buf.byteLength < 2 + messageLength) return;
          const frame = buf.subarray(2, 2 + messageLength);
          socket.data.buffer = buf.subarray(2 + messageLength);
          const handled = handleQuery(ctx, frame, socket.remoteAddress);
          if (handled) socket.write(encodeForTcp(handled.packet));
        }
      },
      timeout(socket) {
        socket.end();
      },
      error(socket) {
        socket.end();
      },
    },
  });
  log(`tcp listening on ${host}:${port}`);
  return { close: () => server.stop(true) };
}
