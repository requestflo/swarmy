import { EventEmitter } from 'node:events';

/** Minimal bidirectional stream over a hijacked Docker exec connection. */
export interface HijackStream {
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  write(data: Buffer | string): void;
  destroy(): void;
}

/**
 * Attach to a Docker exec instance over the raw unix socket.
 *
 * Why not dockerode's `exec.start({ hijack: true })`? Under Bun it never resolves —
 * Bun's HTTP client doesn't surface the hijacked socket on a `Connection: Upgrade`
 * the way dockerode expects, so interactive exec hangs forever (ordinary streaming
 * like `logs` is unaffected). We speak the hijack protocol ourselves: POST
 * /exec/{id}/start with Upgrade, wait for the `101`, then treat the rest of the
 * socket as the bidirectional, Tty-merged stream.
 */
export function attachExec(socketPath: string, execId: string, tty: boolean): Promise<HijackStream> {
  return new Promise((resolve, reject) => {
    const emitter = new EventEmitter();
    let upgraded = false;
    let acc = Buffer.alloc(0);
    const body = JSON.stringify({ Detach: false, Tty: tty });
    const req =
      `POST /exec/${execId}/start HTTP/1.1\r\n` +
      `Host: docker\r\n` +
      `Content-Type: application/json\r\n` +
      `Connection: Upgrade\r\n` +
      `Upgrade: tcp\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body;

    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(req);
        },
        data(socket, chunk: Uint8Array) {
          if (upgraded) {
            emitter.emit('data', Buffer.from(chunk));
            return;
          }
          acc = Buffer.concat([acc, Buffer.from(chunk)]);
          const sep = acc.indexOf('\r\n\r\n');
          if (sep < 0) return; // still reading response headers
          const header = acc.subarray(0, sep).toString('utf8');
          if (!/\s101\s/.test(header)) {
            reject(new Error(`exec attach failed: ${header.split('\r\n')[0]}`));
            socket.end();
            return;
          }
          upgraded = true;
          resolve({
            on: (event: string, cb: (...args: unknown[]) => void) => void emitter.on(event, cb),
            write: (d: Buffer | string) =>
              void socket.write(typeof d === 'string' ? d : new Uint8Array(d)),
            destroy: () => void socket.end(),
          } as HijackStream);
          const rest = acc.subarray(sep + 4);
          if (rest.length) emitter.emit('data', Buffer.from(rest));
          acc = Buffer.alloc(0);
        },
        close() {
          emitter.emit('close');
        },
        error(_socket, err) {
          if (!upgraded) reject(err);
          else emitter.emit('error', err);
        },
      },
    }).catch(reject);
  });
}
