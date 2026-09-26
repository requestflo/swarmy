import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { httpsProbe, parseHead, sameHostRedirect } from './first-look-probe';

describe('first-look probe: redirects stay on the app’s own host', () => {
  it('follows a relative or same-host HTTPS redirect', () => {
    expect(sameHostRedirect('/ghost/', 'blog.example.com', '/')).toBe('/ghost/');
    expect(sameHostRedirect('https://Blog.Example.com/a?b=1', 'blog.example.com', '/')).toBe('/a?b=1');
  });

  it('never follows a redirect to another host, plain HTTP or another port', () => {
    expect(sameHostRedirect('https://169.254.169.254/latest/meta-data', 'blog.example.com', '/')).toBeNull();
    expect(sameHostRedirect('https://evil.example.net/', 'blog.example.com', '/')).toBeNull();
    expect(sameHostRedirect('http://blog.example.com/', 'blog.example.com', '/')).toBeNull();
    expect(sameHostRedirect('https://blog.example.com:8443/', 'blog.example.com', '/')).toBeNull();
  });

  it('reads the status and Location from a response head', () => {
    expect(parseHead('HTTP/1.1 301 Moved Permanently\r\nLocation: /ghost/\r\nServer: Caddy')).toEqual({ status: 301, location: '/ghost/' });
    expect(parseHead('HTTP/2 200\r\ncontent-type: text/html')).toEqual({ status: 200, location: null });
    expect(parseHead('SSH-2.0-OpenSSH')).toBeNull();
  });
});

describe('first-look probe: timeouts', () => {
  let server: Server | null = null;
  const held: Socket[] = [];
  afterEach(() => {
    for (const s of held) s.destroy();
    server?.close();
    server = null;
  });

  it('an edge that accepts but never answers is a plain timeout, not a hang', async () => {
    server = createServer((s) => void held.push(s)); // never speaks TLS
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const t0 = Date.now();
    const r = await httpsProbe({ ip: '127.0.0.1', port, host: 'blog.example.com', path: '/', timeoutMs: 250 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no answer within/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a refused connection says so', async () => {
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    server.close();
    server = null;
    const r = await httpsProbe({ ip: '127.0.0.1', port, host: 'blog.example.com', path: '/', timeoutMs: 1_000 });
    expect(r.ok).toBe(false);
  });
});
