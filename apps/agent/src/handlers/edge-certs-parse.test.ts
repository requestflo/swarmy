import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { certFact, CRT_MARK, edgeCertsExec, parseCertDump, TRUNCATED_MARK } from './edge-certs-parse';

/** A leaf for shop.northwind.dev (+ www), issued by a test "Let's Encrypt R11", 23 Sep → 22 Dec 2026. */
const LEAF = `-----BEGIN CERTIFICATE-----
MIIBezCCASCgAwIBAgIDBKGyMAoGCCqGSM49BAMCMDMxCzAJBgNVBAYTAlVTMRYw
FAYDVQQKDA1MZXQncyBFbmNyeXB0MQwwCgYDVQQDDANSMTEwHhcNMjYwOTIzMTAw
MDAwWhcNMjYxMjIyMTAwMDAwWjAdMRswGQYDVQQDDBJzaG9wLm5vcnRod2luZC5k
ZXYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARbMK5Cdyq3NbZ+y0lrPdPmyZQ+
My9pE5fdwOoyF0qLR2Mxda4LFZ/CccXRNRlAfxmWy3Nr6KJSjD7lk7/vx/kfozkw
NzA1BgNVHREELjAsghJzaG9wLm5vcnRod2luZC5kZXaCFnd3dy5zaG9wLm5vcnRo
d2luZC5kZXYwCgYIKoZIzj0EAwIDSQAwRgIhANsW0SNTN6TfLU1y9hYC3Ars+lOc
6ilCL3NyWZt4uaZWAiEAvm5SVZdog9PYwVpKWwKtaWcCSSVc8yUpmHBUbvkcUAU=
-----END CERTIFICATE-----`;
/** The issuer itself (Caddy stores the chain after the leaf). */
const CA = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUCgAwIBAgIUcUeYJUmc/Yad03WNglfkXPl5+gwwCgYIKoZIzj0EAwIw
MzELMAkGA1UEBhMCVVMxFjAUBgNVBAoMDUxldCdzIEVuY3J5cHQxDDAKBgNVBAMM
A1IxMTAeFw0yNjEwMjUxNjQ2MDhaFw0zNjEwMjIxNjQ2MDhaMDMxCzAJBgNVBAYT
AlVTMRYwFAYDVQQKDA1MZXQncyBFbmNyeXB0MQwwCgYDVQQDDANSMTEwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARC2akjCOoPk3siyoTqthSaYl/+OofVEcSoxntk
dWoZFulBzjwIUm7GroIfj/HLerH8hbqjvpbh5pbqJ9nRW16uozIwMDAdBgNVHQ4E
FgQUELd8i1A+6Z0VmoLb/QmwB6BcaZcwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjO
PQQDAgNJADBGAiEApiDV8Wki7iFgNpKRgOKCVLuBZcz9VruGBGeRqPzifDsCIQDK
QzSKBuNoWpo/eaK2moGlJ9y2YNFihn7aMk5osrrAwQ==
-----END CERTIFICATE-----`;
/** A wildcard: *.northwind.dev + northwind.dev, 1 Sep → 30 Nov 2026. */
const WILD = `-----BEGIN CERTIFICATE-----
MIIBbTCCARKgAwIBAgIEAMD/7jAKBggqhkjOPQQDAjAzMQswCQYDVQQGEwJVUzEW
MBQGA1UECgwNTGV0J3MgRW5jcnlwdDEMMAoGA1UEAwwDUjExMB4XDTI2MDkwMTAw
MDAwMFoXDTI2MTEzMDAwMDAwMFowGjEYMBYGA1UEAwwPKi5ub3J0aHdpbmQuZGV2
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEJVk3VMePSqGwit6IX7RlMFWY/wep
v9cCPDZvJPW7Sg6/BJaPckJ6Cc80jwEYKzR2qVkQEqTEIAA7wQYa36QDm6MtMCsw
KQYDVR0RBCIwIIIPKi5ub3J0aHdpbmQuZGV2gg1ub3J0aHdpbmQuZGV2MAoGCCqG
SM49BAMCA0kAMEYCIQCdlKzBoVt4zY9OkcZj/iv5cIhXbrvl4vrTkcAD+cmdnwIh
ALzNFimX3AdD113Opv1qoy0kT2365iqKHmR6JFsqAXVG
-----END CERTIFICATE-----`;
/** Not a real key: a stand-in that must never reach the output. */
const KEY = '-----BEGIN EC PRIVATE KEY-----\nTk9ULUEtUkVBTC1LRVk=\n-----END EC PRIVATE KEY-----';
const LE = 'acme-v02.api.letsencrypt.org-directory';

describe('certFact', () => {
  it('reads the leaf (not the chain after it) into public facts', () => {
    expect(certFact(`${LE}/shop.northwind.dev/shop.northwind.dev.crt`, `${LEAF}\n${CA}\n`)).toEqual({
      name: 'shop.northwind.dev',
      issuerKey: LE,
      issuer: "Let's Encrypt R11",
      notBefore: '2026-09-23T10:00:00.000Z',
      notAfter: '2026-12-22T10:00:00.000Z',
      names: ['shop.northwind.dev', 'www.shop.northwind.dev'],
      serial: '04A1B2',
      fingerprint256: '57:97:0F:D3:99:F1:C0:85:B4:5B:58:B1:37:1D:0B:F2:57:68:E3:06:01:D6:7A:A5:D8:44:AF:8E:51:D4:F8:CB',
    });
  });

  it('keeps a wildcard name as Caddy stores it', () => {
    const f = certFact(`${LE}/wildcard_.northwind.dev/wildcard_.northwind.dev.crt`, WILD);
    expect(f?.name).toBe('wildcard_.northwind.dev');
    expect(f?.names).toEqual(['*.northwind.dev', 'northwind.dev']);
  });

  it('refuses any other path shape, a key, and garbage', () => {
    expect(certFact(`${LE}/a/b.crt`, LEAF)).toBeNull();
    expect(certFact(`shop.northwind.dev.crt`, LEAF)).toBeNull();
    expect(certFact(`${LE}/k/k.crt`, KEY)).toBeNull();
    expect(certFact(`${LE}/g/g.crt`, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toBeNull();
  });
});

describe('parseCertDump', () => {
  it('splits the loop output per file and notes the cap', () => {
    const out = `\n${CRT_MARK}${LE}/shop.northwind.dev/shop.northwind.dev.crt\n${LEAF}\n${CA}\n\n${CRT_MARK}local/x/x.crt\n${KEY}\n${TRUNCATED_MARK}\n`;
    const r = parseCertDump(out);
    expect(r.certs.map((c) => c.name)).toEqual(['shop.northwind.dev']);
    expect(r.truncated).toBe(true);
    expect(parseCertDump('').certs).toEqual([]);
  });
});

describe('edgeCertsExec (run against a real temp storage tree)', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const run = (max = 500) => {
    const { Cmd, Env } = edgeCertsExec(dir, max);
    const env = Object.fromEntries(Env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    return Bun.spawnSync(Cmd, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }).stdout.toString();
  };

  it('prints only regular .crt files: never the key, the json, or a .crt symlink to a key', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'swarmy-crt-'));
    const host = path.join(dir, LE, 'shop.northwind.dev');
    mkdirSync(host, { recursive: true });
    writeFileSync(path.join(host, 'shop.northwind.dev.crt'), `${LEAF}\n${CA}\n`);
    writeFileSync(path.join(host, 'shop.northwind.dev.key'), KEY);
    writeFileSync(path.join(host, 'shop.northwind.dev.json'), '{"sans":["shop.northwind.dev"]}');
    mkdirSync(path.join(dir, LE, 'evil'), { recursive: true });
    symlinkSync(path.join(host, 'shop.northwind.dev.key'), path.join(dir, LE, 'evil', 'evil.crt'));
    const out = run();
    expect(out).not.toContain('PRIVATE KEY');
    expect(out).not.toContain('"sans"');
    expect(parseCertDump(out).certs.map((c) => c.name)).toEqual(['shop.northwind.dev']);
  });

  it('caps the count, and an absent store prints nothing', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'swarmy-crt-'));
    for (const n of ['a.dev', 'b.dev']) {
      mkdirSync(path.join(dir, LE, n), { recursive: true });
      writeFileSync(path.join(dir, LE, n, `${n}.crt`), LEAF);
    }
    expect(parseCertDump(run(1))).toEqual({ certs: [expect.objectContaining({ name: 'a.dev' })], truncated: true });
    rmSync(dir, { recursive: true, force: true });
    expect(run()).toBe('');
  });
});
