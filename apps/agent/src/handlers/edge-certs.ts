import type { DockerClient } from '@swarmy/core/docker';
import type { EdgeCertsResult } from '@swarmy/core/protocol';
import { edgeCertsExec, parseCertDump } from './edge-certs-parse';
import { execCapture, localEdgeTask } from './edge-exec';

/**
 * `edgeCerts`: the certificates this node's edge Caddy holds (protocol
 * edge-certs.ts). One in-task loop prints the `.crt` files only; they are
 * parsed here and only public facts are answered. A node with no edge task
 * answers `edge: false`, never an error, so the controller can ask every
 * edge without knowing which still runs one.
 *
 * No exec veto: like the metrics scrape and the config reload, it reaches
 * swarmy's own edge task (no user code, no user credentials), and it reads.
 */
export async function readEdgeCerts(docker: DockerClient, now: () => number = Date.now): Promise<EdgeCertsResult> {
  const checkedAt = new Date(now()).toISOString();
  const task = await localEdgeTask(docker);
  if (!task) return { edge: false, certs: [], truncated: false, checkedAt };
  const out = await execCapture(docker, task, edgeCertsExec());
  if (out.exitCode !== 0) {
    throw new Error(`reading the edge's certificates exited ${out.exitCode}${out.stderr ? `: ${out.stderr}` : ''}`);
  }
  const { certs, truncated } = parseCertDump(out.stdout);
  return { edge: true, certs, truncated: truncated || out.capped, checkedAt };
}
