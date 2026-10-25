import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EdgeCertRenewPayload } from '@swarmy/core/protocol';
import { renewEdgeCert } from './edge-cert-renew';

/**
 * Renew now, end to end over the real shell steps: a docker stand-in runs
 * each exec as a local `sh` against a temp "Caddy data" tree, and a fake
 * `caddy reload` issues a new certificate only when told to (an `issue`
 * file), as a CA that answers or doesn't.
 */

const OLD = `-----BEGIN CERTIFICATE-----
MIIBezCCASCgAwIBAgIDBKGyMAoGCCqGSM49BAMCMDMxCzAJBgNVBAYTAlVTMRYw
FAYDVQQKDA1MZXQncyBFbmNyeXB0MQwwCgYDVQQDDANSMTEwHhcNMjYwOTIzMTAw
MDAwWhcNMjYxMjIyMTAwMDAwWjAdMRswGQYDVQQDDBJzaG9wLm5vcnRod2luZC5k
ZXYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARbMK5Cdyq3NbZ+y0lrPdPmyZQ+
My9pE5fdwOoyF0qLR2Mxda4LFZ/CccXRNRlAfxmWy3Nr6KJSjD7lk7/vx/kfozkw
NzA1BgNVHREELjAsghJzaG9wLm5vcnRod2luZC5kZXaCFnd3dy5zaG9wLm5vcnRo
d2luZC5kZXYwCgYIKoZIzj0EAwIDSQAwRgIhANsW0SNTN6TfLU1y9hYC3Ars+lOc
6ilCL3NyWZt4uaZWAiEAvm5SVZdog9PYwVpKWwKtaWcCSSVc8yUpmHBUbvkcUAU=
-----END CERTIFICATE-----`;
const NEW = `-----BEGIN CERTIFICATE-----
MIIBYjCCAQigAwIBAgIDBbLDMAoGCCqGSM49BAMCMDMxCzAJBgNVBAYTAlVTMRYw
FAYDVQQKDA1MZXQncyBFbmNyeXB0MQwwCgYDVQQDDANSMTEwHhcNMjYxMDI0MTEw
MDAwWhcNMjcwMTIyMTEwMDAwWjAdMRswGQYDVQQDDBJzaG9wLm5vcnRod2luZC5k
ZXYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARbMK5Cdyq3NbZ+y0lrPdPmyZQ+
My9pE5fdwOoyF0qLR2Mxda4LFZ/CccXRNRlAfxmWy3Nr6KJSjD7lk7/vx/kfoyEw
HzAdBgNVHREEFjAUghJzaG9wLm5vcnRod2luZC5kZXYwCgYIKoZIzj0EAwIDSAAw
RQIhAJP9Lsph24baTnmolY4XK95steDcD6AcKhlaXVpbdGF2AiBcoeNf5ZaUZX2A
JWp8KhWWKFe11g6AxVHfu2iyM6WvaQ==
-----END CERTIFICATE-----`;
const HOST = 'shop.northwind.dev';
const LE = 'acme-v02.api.letsencrypt.org-directory';

let root = '';
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function setup(opts: { held?: boolean; issues?: boolean } = {}) {
  root = mkdtempSync(path.join(tmpdir(), 'swarmy-renew-'));
  const dir = path.join(root, 'certificates', LE, HOST);
  if (opts.held !== false) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${HOST}.crt`), OLD);
    writeFileSync(path.join(dir, `${HOST}.key`), 'old-key');
  }
  if (opts.issues) writeFileSync(path.join(root, 'issue'), '');
  writeFileSync(path.join(root, 'new.pem'), `${NEW}\n`);
  // A fake `caddy reload`: log it; with the host configured, no stored cert and a CA that answers, store a new one.
  const caddy = [
    `cd ${root}`,
    'echo "$(grep -c shop Caddyfile)" >> reloads',
    `if grep -q '^${HOST}' Caddyfile && [ ! -f certificates/${LE}/${HOST}/${HOST}.crt ] && [ -f issue ]; then`,
    `  mkdir -p certificates/${LE}/${HOST} && cp new.pem certificates/${LE}/${HOST}/${HOST}.crt`,
    'fi',
  ].join('\n');
  const payload: EdgeCertRenewPayload = {
    commandId: '00000000-0000-4000-8000-000000000321',
    name: HOST,
    service: 'swarmy-ingress-caddy',
    command: ['sh', '-c', caddy],
    without: { path: path.join(root, 'Caddyfile'), contents: 'api.northwind.dev {\n}\n' },
    full: { path: path.join(root, 'Caddyfile'), contents: `${HOST} {\n}\napi.northwind.dev {\n}\n` },
    waitMs: 30_000,
  };
  return { payload, dir, reloads: () => (existsSync(path.join(root, 'reloads')) ? readFileSync(path.join(root, 'reloads'), 'utf8').trim().split('\n') : []) };
}

/** A docker socket whose exec runs the command here, as `sh` would in the task. */
const docker = {
  docker: {
    listContainers: async () => [{ Id: 'edge' }],
    getContainer: () => ({
      exec: async (o: { Cmd: string[]; Env?: string[] }) => {
        const env = Object.fromEntries((o.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
        const r = Bun.spawnSync(o.Cmd, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
        return {
          start: async () => {
            const s = new EventEmitter();
            const frame = (t: number, b: Buffer) => {
              const h = Buffer.alloc(8);
              h[0] = t;
              h.writeUInt32BE(b.length, 4);
              return b.length ? Buffer.concat([h, b]) : Buffer.alloc(0);
            };
            setTimeout(() => {
              s.emit('data', Buffer.concat([frame(1, r.stdout), frame(2, r.stderr)]));
              s.emit('end');
            }, 0);
            return s;
          },
          inspect: async () => ({ ExitCode: r.exitCode }),
        };
      },
    }),
  },
} as never;

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), pollMs: 3_000, data: root };
};

describe('renewEdgeCert', () => {
  it('a CA that answers: reload without, move aside, reload with → a new certificate, the old copy dropped', async () => {
    const w = setup({ issues: true });
    const r = await renewEdgeCert(docker, w.payload, clock());
    expect(r.outcome).toBe('renewed');
    expect(r.previous?.serial).toBe('04A1B2');
    expect(r.cert?.serial).toBe('05B2C3');
    expect(w.reloads()).toEqual(['0', '1']);
    expect(existsSync(path.join(root, 'swarmy-renew', LE, HOST))).toBe(false);
  });

  it('a CA that never answers: the old certificate and its key are put back and loaded again', async () => {
    const w = setup({ issues: false });
    const r = await renewEdgeCert(docker, w.payload, clock());
    expect(r.outcome).toBe('restored');
    expect(r.cert?.serial).toBe('04A1B2');
    expect(r.message).toBe('no new certificate within 30 s; the previous one is back and still serving');
    expect(readFileSync(path.join(w.dir, `${HOST}.key`), 'utf8')).toBe('old-key');
    expect(w.reloads()).toEqual(['0', '1', '0', '1']);
    expect(existsSync(path.join(root, 'swarmy-renew', LE, HOST))).toBe(false);
  });

  it('an edge that holds none changes nothing', async () => {
    const w = setup({ held: false });
    expect((await renewEdgeCert(docker, w.payload, clock())).outcome).toBe('no_cert');
    expect(w.reloads()).toEqual([]);
  });

  it('a copy left aside by an interrupted renew comes back before anything else', async () => {
    const w = setup({ held: false, issues: true });
    mkdirSync(path.join(root, 'swarmy-renew', LE, HOST), { recursive: true });
    writeFileSync(path.join(root, 'swarmy-renew', LE, HOST, `${HOST}.crt`), OLD);
    const r = await renewEdgeCert(docker, w.payload, clock());
    expect(r.previous?.serial).toBe('04A1B2');
    expect(r.outcome).toBe('renewed');
  });
});
