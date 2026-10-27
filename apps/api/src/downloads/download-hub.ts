import {
  AGENT_CAPABILITY,
  STREAM_CHUNK_BYTES,
  agentSupports,
  decodeStreamChunk,
  type StreamEndPayload,
} from '@swarmy/core/protocol';
import type { DownloadClaims, DownloadStatusView } from '@swarmy/trpc';
import { TicketStore } from '../terminal-tickets';
import { downloadErrorWords } from './download-words';
import { LiveDownload, type DownloadOutcome } from './live-download';

/**
 * Every snapshot download on this controller: the single-use tickets tRPC
 * mints, the live streams (agent chunks → HTTP body), and a short-lived status
 * per download for the dialog. A chunk is accepted only from the node its
 * stream was started on; a chunk for a stream nobody holds is answered with
 * `streamCancel`, so an agent never keeps reading for a reader that is gone.
 */

export interface DownloadHubDeps {
  /** Downloads streaming at once on this controller (`maxLiveDownloads`). */
  maxLive: number;
  send(nodeId: string, type: string, payload: unknown): boolean;
  isOnline(nodeId: string): boolean;
  capabilities(nodeId: string): readonly string[] | undefined;
  audit(claims: DownloadClaims, outcome: DownloadOutcome, bytes: number, error: string | null): void;
}

type Status = DownloadStatusView & { orgId: string; userId: string };
export type OpenResult =
  | { ok: true; claims: DownloadClaims; body: ReadableStream<Uint8Array> }
  | { ok: false; status: number; message: string };

/** How long a finished download's status stays readable. */
const STATUS_TTL_MS = 15 * 60_000;
/** The agent sent nothing for this long while the browser waited: give up. */
export const DOWNLOAD_STALL_MS = 5 * 60_000;

export class DownloadHub {
  private tickets = new TicketStore<DownloadClaims>();
  private live = new Map<string, LiveDownload>();
  private status = new Map<string, Status>();

  constructor(private readonly deps: DownloadHubDeps) {}

  mint(claims: DownloadClaims): { ticket: string; expiresAt: number } {
    this.tickets.sweep(); // unclaimed tickets hold repo credentials: never let them pile up
    this.sweepStatus();
    this.setStatus(claims, 'ready', 0, null);
    return this.tickets.mint(claims);
  }

  statusOf(downloadId: string): Status | undefined {
    return this.status.get(downloadId);
  }

  /** The route claimed a ticket: start the agent's stream and hand back the body. */
  open(ticket: string, userId: string): OpenResult {
    const c = this.tickets.claim(ticket);
    if (!c) return { ok: false, status: 410, message: 'This download link has expired or was already used. Start it again from Backups.' };
    if (c.userId !== userId) return { ok: false, status: 403, message: 'This download link was made for someone else.' };
    const refuse = (message: string): OpenResult => (this.setStatus(c, 'failed', 0, message), { ok: false, status: 503, message });
    if (this.live.size >= this.deps.maxLive) {
      return refuse(`${this.deps.maxLive} downloads are already running on this controller. Start this one when one of them finishes.`);
    }
    if (!this.deps.isOnline(c.nodeId)) return refuse('The server that reads this save went offline. Try again in a moment.');
    if (!agentSupports(this.deps.capabilities(c.nodeId), AGENT_CAPABILITY.snapshotDump)) {
      return refuse('The server that reads this save runs an agent too old to stream downloads. Update it from Servers.');
    }
    const d = new LiveDownload(c.downloadId, c.nodeId, c.maxBytes, {
      credit: (grant) => this.deps.send(c.nodeId, 'streamCredit', { streamId: c.downloadId, grant }),
      cancel: (reason) => this.deps.send(c.nodeId, 'streamCancel', { streamId: c.downloadId, reason: reason.slice(0, 200) }),
      settle: (outcome, bytes, error) => {
        this.live.delete(c.downloadId);
        const words = error ? downloadErrorWords(error.code, error.message, c.maxBytes) : null;
        this.setStatus(c, outcome, bytes, words);
        this.deps.audit(c, outcome, bytes, error ? `${error.code}: ${error.message}` : null);
      },
    });
    this.live.set(c.downloadId, d);
    const sent = this.deps.send(c.nodeId, 'snapshotDump', {
      streamId: c.downloadId,
      ...c.start,
      credit: d.receiver.initialCredit,
      chunkBytes: STREAM_CHUNK_BYTES,
      maxBytes: c.maxBytes,
    });
    if (!sent) {
      d.fail('E_AGENT_GONE', 'the agent link dropped', false);
      return { ok: false, status: 503, message: 'The server that reads this save went offline. Try again in a moment.' };
    }
    this.setStatus(c, 'streaming', 0, null);
    return { ok: true, claims: c, body: d.body };
  }

  /** A binary frame from a node's agent socket. */
  onChunk(nodeId: string, frame: Uint8Array): void {
    const c = decodeStreamChunk(frame);
    if (!c) return;
    const d = this.live.get(c.streamId);
    if (!d) {
      this.deps.send(nodeId, 'streamCancel', { streamId: c.streamId, reason: 'no reader for this download' });
      return;
    }
    if (d.nodeId !== nodeId) return; // never let one node write into another's download
    d.chunk(c.seq, c.data);
    const s = this.status.get(c.streamId);
    if (s && s.state === 'streaming') Object.assign(s, { bytes: d.receiver.bytes, updatedAt: Date.now() });
  }

  onEnd(nodeId: string, p: StreamEndPayload): void {
    const d = this.live.get(p.streamId);
    if (d && d.nodeId === nodeId) d.end(p);
  }

  /** The node's agent link closed: its downloads can't finish. */
  onAgentGone(nodeId: string): void {
    for (const d of [...this.live.values()]) {
      if (d.nodeId === nodeId) d.fail('E_AGENT_GONE', 'the agent link closed', false);
    }
  }

  /** Stop downloads whose agent went quiet while the browser waited. */
  sweep(now = Date.now()): void {
    for (const d of [...this.live.values()]) {
      if (d.starved && now - d.lastHeardAt > DOWNLOAD_STALL_MS) d.fail('E_STALLED', 'the agent sent nothing for 5 minutes', true);
    }
  }

  private setStatus(c: DownloadClaims, state: Status['state'], bytes: number, error: string | null): void {
    this.status.set(c.downloadId, { orgId: c.orgId, userId: c.userId, state, bytes, error, updatedAt: Date.now() });
  }

  private sweepStatus(now = Date.now()): void {
    for (const [id, s] of this.status) {
      if (now - s.updatedAt > STATUS_TTL_MS && !this.live.has(id)) this.status.delete(id);
    }
  }
}
