import type { DockerClient } from '@swarmy/core/docker';
import { EDGE_CERT_DIR, type EdgeCertFact, type EdgeCertRenewPayload, type EdgeCertRenewResult } from '@swarmy/core/protocol';
import { edgeCertsExec, parseCertDump } from './edge-certs-parse';
import { dropBackupExec, EDGE_CADDY_DATA, moveAsideExec, restoreExec } from './edge-cert-renew-scripts';
import { execCapture, localEdgeTask } from './edge-exec';
import { writeFileExec } from './ingress-local';

/**
 * `edgeCertRenew` (protocol edge-cert-renew.ts): re-issue one certificate on
 * this node's edge Caddy, never leaving it without one. Caddy keeps managed
 * certificates in memory across reloads, so: reload without the host (Caddy
 * drops it), move its stored copy aside, reload with it (Caddy finds none and
 * orders one), wait for the new `.crt`. No new one in time → put the old copy
 * back and reload twice more, so Caddy loads it again (and the pending order
 * is cancelled with the old config).
 *
 * Same reach as `applyIngress`'s in-task reload: swarmy's own edge task, its
 * own Caddyfile and its own certificate directory; no exec veto applies.
 */

export interface RenewDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  /** Caddy's data directory inside the task (tests point it at a temp tree). */
  data: string;
}

const DEFAULTS: RenewDeps = {
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs: 3_000,
  data: EDGE_CADDY_DATA,
};

const newest = (certs: EdgeCertFact[]): EdgeCertFact | null =>
  certs.reduce<EdgeCertFact | null>((a, c) => (!a || c.notAfter > a.notAfter ? c : a), null);

export async function renewEdgeCert(docker: DockerClient, p: EdgeCertRenewPayload, opts: Partial<RenewDeps> = {}): Promise<EdgeCertRenewResult> {
  const d = { ...DEFAULTS, ...opts };
  const started = d.now();
  const took = () => Math.max(0, d.now() - started);
  const task = await localEdgeTask(docker, p.service);
  if (!task) throw new Error(`no running local task of ${p.service}: nothing to renew on this node`);

  const sh = async (x: { Cmd: string[]; Env?: string[] }, what: string) => {
    const o = await execCapture(docker, task, x);
    if (o.exitCode !== 0) throw new Error(`${what} exited ${o.exitCode}${o.stderr ? `: ${o.stderr}` : ''}`);
    return o.stdout;
  };
  const certDir = d.data === EDGE_CADDY_DATA ? EDGE_CERT_DIR : `${d.data}/certificates`;
  const held = async () => newest(parseCertDump(await sh(edgeCertsExec(certDir, 20, p.name), 'reading the certificate')).certs.filter((c) => c.name === p.name));
  const reload = async (file: { path: string; contents: string }) => {
    await sh(writeFileExec(file), `write ${file.path}`);
    await sh({ Cmd: p.command }, 'caddy reload');
  };
  const putBack = async () => {
    await reload(p.without).catch(() => undefined);
    await sh(restoreExec(p.name, d.data), 'putting the certificate back');
    await reload(p.full);
  };

  // An earlier renew cut short (agent restart mid-wait) puts its copy back first.
  await sh(restoreExec(p.name, d.data), 'recovering an earlier renew');
  const before = await held();
  if (!before) return { outcome: 'no_cert', cert: null, previous: null, message: 'this edge holds no certificate for it', tookMs: took() };

  await reload(p.without);
  try {
    await sh(moveAsideExec(p.name, d.data), 'moving the certificate aside');
    await reload(p.full);
  } catch (e) {
    await putBack().catch(() => undefined);
    throw e;
  }

  while (d.now() - started < p.waitMs) {
    await d.sleep(d.pollMs);
    const now = await held().catch(() => null);
    if (now && now.serial !== before.serial) {
      await sh(dropBackupExec(p.name, d.data), 'dropping the old copy').catch(() => undefined);
      return { outcome: 'renewed', cert: now, previous: before, message: `${p.name} has a new certificate`, tookMs: took() };
    }
  }
  await putBack();
  const after = await held().catch(() => null);
  if (after && after.serial !== before.serial) {
    return { outcome: 'renewed', cert: after, previous: before, message: `${p.name} has a new certificate`, tookMs: took() };
  }
  return {
    outcome: 'restored',
    cert: after ?? before,
    previous: before,
    message: `no new certificate within ${Math.round(p.waitMs / 1000)} s; the previous one is back and still serving`,
    tookMs: took(),
  };
}
