import type { LogRowView } from '@swarmy/core';

/**
 * Demo: the app-log line behind each failed request a demo replay recorded,
 * logged with the edge's request id as a field (`request_id`), so a replay's
 * "Find in logs" lands on it — the logs search matches an attribute equal to
 * the term, as the real query does. rum-replay.ts registers them as it builds
 * recordings; `observability.logs` merges them in.
 */

interface FailedRequest {
  tsMs: number;
  service: string;
  body: string;
  traceId: string;
}

const failed = new Map<string, FailedRequest>();

export function registerFailedRequest(requestId: string, r: FailedRequest): void {
  failed.set(requestId, r);
}

export function replayRequestLogRows(): LogRowView[] {
  return [...failed].map(([requestId, r]) => ({
    timestamp: new Date(r.tsMs).toISOString().replace('T', ' ').replace('Z', ''),
    ts_nano: `${Math.floor(r.tsMs)}000000`,
    trace_id: r.traceId,
    span_id: '',
    severity_text: 'ERROR',
    severity_number: 17,
    service_name: r.service,
    body: r.body,
    attributes: { request_id: requestId },
    source: 'otlp',
  }));
}
