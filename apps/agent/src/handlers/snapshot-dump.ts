import { bytesWords } from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import {
  CreditSender,
  encodeStreamChunk,
  type SnapshotDumpPayload,
  type StreamCancelPayload,
  type StreamCreditPayload,
  type StreamErrorCode,
} from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import { env } from '../env';
import { DumpPump, type PumpEnd } from './dump-pump';
import { dumpArgs, readSidecar } from './snapshot-read';
import { prepareSidecarStream, type SidecarStream } from './sidecar-stream';

/**
 * `snapshotDump`: stream one file or folder out of a volume backup to the
 * controller (board 16 download). restic runs as a streamed sidecar, its
 * stdout goes through the credit pump as binary chunk frames, and the stream
 * ends with exactly one `streamEnd`. Stops on: controller cancel, the byte
 * cap (the controller's, or this agent's own SWARMY_SNAPSHOT_DOWNLOAD_MAX_BYTES),
 * no credit for {@link DUMP_STALL_MS} (the reader or the link is gone).
 */

/** Downloads one agent serves at once. */
export const MAX_DUMPS = 4;
/** No credit for this long while output waits: the reader is gone. */
export const DUMP_STALL_MS = 60_000;

interface Session {
  pump: DumpPump;
  side?: SidecarStream;
  watch: ReturnType<typeof setInterval>;
}

const sessions = new Map<string, Session>();

/** Live downloads on this agent (doctor / tests). */
export function activeDumps(): number {
  return sessions.size;
}

function endFrame(conn: AgentConnection, streamId: string, r: PumpEnd): void {
  conn.send('streamEnd', { streamId, ...r });
}

function refuse(conn: AgentConnection, streamId: string, code: StreamErrorCode, message: string): void {
  endFrame(conn, streamId, { ok: false, bytes: 0, error: { code, message } });
}

export async function handleSnapshotDump(docker: DockerClient, conn: AgentConnection, p: SnapshotDumpPayload): Promise<void> {
  const id = p.streamId;
  if (!env.ALLOW_SNAPSHOT_DOWNLOAD) {
    return refuse(conn, id, 'E_DISABLED', 'downloads from backups are turned off on this server (SWARMY_ALLOW_SNAPSHOT_DOWNLOAD=false)');
  }
  if (sessions.has(id)) return; // a replayed start: the live one answers
  if (sessions.size >= MAX_DUMPS) return refuse(conn, id, 'E_BUSY', `this server is already serving ${MAX_DUMPS} downloads`);

  const agentCap = env.SNAPSHOT_DOWNLOAD_MAX_BYTES;
  const maxBytes = Math.min(p.maxBytes, agentCap);
  const capWords =
    agentCap < p.maxBytes
      ? `past this server’s ${bytesWords(agentCap)} download limit (SWARMY_SNAPSHOT_DOWNLOAD_MAX_BYTES)`
      : `past this download’s ${bytesWords(maxBytes)} limit`;

  const session = { watch: undefined as unknown as Session['watch'] } as Session;
  session.pump = new DumpPump(
    {
      sendChunk: (seq, data) => conn.sendBinary(encodeStreamChunk(id, seq, data)),
      pause: () => session.side?.pause(),
      resume: () => session.side?.resume(),
      end: (r) => {
        clearInterval(session.watch);
        sessions.delete(id);
        if (!r.ok) session.side?.kill();
        endFrame(conn, id, r);
      },
    },
    new CreditSender(p.credit, maxBytes),
    p.chunkBytes,
    capWords,
  );
  sessions.set(id, session);
  session.watch = setInterval(() => {
    if (session.pump.stalledFor() > DUMP_STALL_MS) {
      session.pump.fail('E_STALLED', `nothing read this download for ${DUMP_STALL_MS / 1000}s`);
    }
  }, 5_000);

  try {
    const side = await prepareSidecarStream(docker, { ...readSidecar(p), args: dumpArgs(p) }, (data) => session.pump.data(data));
    session.side = side;
    if (session.pump.done) return side.kill(); // canceled while the image pulled
    await side.start();
    const code = await side.done;
    session.pump.exited(code, side.stderr());
  } catch (e) {
    session.pump.fail('E_SOURCE', e instanceof Error ? e.message : String(e));
  }
}

export function handleStreamCredit(p: StreamCreditPayload): void {
  sessions.get(p.streamId)?.pump.credit(p.grant);
}

export function handleStreamCancel(p: StreamCancelPayload): void {
  sessions.get(p.streamId)?.pump.fail('E_CANCELED', p.reason ?? 'the controller stopped the download');
}
