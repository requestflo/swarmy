import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dropBackupExec, moveAsideExec, restoreExec } from './edge-cert-renew-scripts';

/** The renew's shell steps, run as `sh` against a real temp Caddy data tree. */

const LE = 'acme-v02.api.letsencrypt.org-directory';
const ZS = 'acme.zerossl.com-v2-dv90';
let root = '';
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

function tree(): string {
  root = mkdtempSync(path.join(tmpdir(), 'swarmy-aside-'));
  for (const [issuer, host] of [[LE, 'shop.dev'], [ZS, 'shop.dev'], [LE, 'api.dev']] as const) {
    const d = path.join(root, 'certificates', issuer, host);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, `${host}.crt`), `${issuer} crt`);
    writeFileSync(path.join(d, `${host}.key`), `${issuer} key`);
  }
  return root;
}
const run = (x: { Cmd: string[]; Env: string[] }) => {
  const env = Object.fromEntries(x.Env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const r = Bun.spawnSync(x.Cmd, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};
const has = (...p: string[]) => existsSync(path.join(root, ...p));

describe('renew shell steps', () => {
  it('moves only that host aside, under every issuer, keys included (renamed, not deleted)', () => {
    tree();
    expect(run(moveAsideExec('shop.dev', root))).toEqual({ code: 0, out: 'moved 2' });
    expect(has('certificates', LE, 'shop.dev')).toBe(false);
    expect(has('certificates', LE, 'api.dev', 'api.dev.crt')).toBe(true);
    expect(readFileSync(path.join(root, 'swarmy-renew', ZS, 'shop.dev', 'shop.dev.key'), 'utf8')).toBe(`${ZS} key`);
  });

  it('restore puts it back, but keeps a new certificate that already landed', () => {
    tree();
    run(moveAsideExec('shop.dev', root));
    mkdirSync(path.join(root, 'certificates', LE, 'shop.dev'), { recursive: true });
    writeFileSync(path.join(root, 'certificates', LE, 'shop.dev', 'shop.dev.crt'), 'new crt');
    expect(run(restoreExec('shop.dev', root))).toEqual({ code: 0, out: 'restored' });
    expect(readFileSync(path.join(root, 'certificates', LE, 'shop.dev', 'shop.dev.crt'), 'utf8')).toBe('new crt');
    expect(readFileSync(path.join(root, 'certificates', ZS, 'shop.dev', 'shop.dev.crt'), 'utf8')).toBe(`${ZS} crt`);
    expect(has('swarmy-renew', LE, 'shop.dev')).toBe(false);
  });

  it('drop deletes only the moved-aside copy; every step is a no-op when there is nothing', () => {
    tree();
    run(moveAsideExec('shop.dev', root));
    expect(run(dropBackupExec('shop.dev', root)).code).toBe(0);
    expect(has('swarmy-renew', LE, 'shop.dev')).toBe(false);
    expect(has('certificates', LE, 'api.dev')).toBe(true);
    expect(run(restoreExec('none.dev', root))).toEqual({ code: 0, out: 'restored' });
    expect(run(moveAsideExec('none.dev', root))).toEqual({ code: 0, out: 'moved 0' });
  });
});
