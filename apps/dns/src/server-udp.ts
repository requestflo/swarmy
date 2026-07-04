import { encodeForUdp } from '@swarmy/dns';
import { log } from './config';
import { handleQuery, type QueryContext } from './query';

/** DNS over UDP — Bun's native udpSocket, one datagram per query. */
export async function startUdpServer(
  ctx: QueryContext,
  host: string,
  port: number,
): Promise<{ close(): void }> {
  const socket = await Bun.udpSocket({
    hostname: host,
    port,
    socket: {
      data(sock, buf, peerPort, addr) {
        const handled = handleQuery(ctx, buf, addr);
        if (!handled) return; // unparseable — drop
        const response = encodeForUdp(handled.packet, handled.parsed.udpPayloadSize);
        // Backpressure returns false — drop; DNS clients retry (often via TCP).
        sock.send(response, peerPort, addr);
      },
    },
  });
  log(`udp listening on ${host}:${port}`);
  return { close: () => socket.close() };
}
