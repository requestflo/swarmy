import { encodeForUdp } from '@swarmy/dns';
import { log } from './config';
import { handleQuery, type QueryContext } from './query';

/** DNS over UDP — Bun's native udpSocket, one datagram per query. */
export async function startUdpServer(
  ctx: QueryContext,
  host: string,
  port: number,
): Promise<{ close(): void }> {
  let lastErrorLog = 0;
  const socket = await Bun.udpSocket({
    hostname: host,
    port,
    socket: {
      data(sock, buf, peerPort, addr) {
        const handled = handleQuery(ctx, buf, addr);
        if (!handled) return; // unparseable — drop
        const response = encodeForUdp(handled.packet, handled.parsed.udpPayloadSize);
        // Backpressure returns false — drop; DNS clients retry (often via TCP).
        try {
          sock.send(response, peerPort, addr);
        } catch {
          // a vanished client: drop, never take the nameserver down with it
        }
      },
      // Without a handler Bun throws socket errors out of the event loop. A
      // client that is gone by the time we answer comes back as an ICMP
      // port-unreachable → ECONNREFUSED on the next recv, and that killed the
      // whole server (QA-048). One client's error must never stop the NS.
      error(_sock, err) {
        const now = Date.now();
        if (now - lastErrorLog > 60_000) {
          lastErrorLog = now;
          log(`udp ${host}:${port}: ignoring socket error (logged at most once a minute): ${err.message}`);
        }
      },
    },
  });
  log(`udp listening on ${host}:${port}`);
  return { close: () => socket.close() };
}
