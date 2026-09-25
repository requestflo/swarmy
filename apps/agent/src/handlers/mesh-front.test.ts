import { describe, expect, test } from 'bun:test';
import { MESH_FRONT_PORT, meshFrontFor, renderFrontFallback, renderFrontScript } from './mesh-front';

// Exactly what install-swarmy.sh's mesh_control_config renders behind the edge / at bootstrap.
const cfg = (exposed: string, extra = '') => `# swarmy-managed NetBird control plane — rendered by install-swarmy.sh.
{
  "server": {
    "exposedAddress": "${exposed}",
    "listenAddress": ":8081",
    "store": { "encryptionKey": "k", "engine": "sqlite" }${extra}
  }
}`;

describe('mesh front (QA-066 f: the mesh domain without the swarm edge)', () => {
  test('only behind the edge: https exposed, NetBird not terminating TLS itself', () => {
    expect(meshFrontFor(cfg('https://mesh.lab:443'))).toEqual({ domain: 'mesh.lab', port: 443, upstream: '127.0.0.1:8081' });
    expect(meshFrontFor(cfg('https://mesh.example.com:8444'))?.port).toBe(8444);
    expect(meshFrontFor(cfg('http://mesh-1-2-3-4.sslip.io:8081'))).toBeNull(); // bootstrap: plain, no edge involved
    expect(meshFrontFor(cfg('https://mesh.lab:443', ',\n    "tls": { "letsencrypt": { "enabled": true } }'))).toBeNull();
    expect(meshFrontFor('not json')).toBeNull();
    expect(meshFrontFor(cfg("https://evil';rm -rf /;'.x:443"))).toBeNull();
  });

  test('the front serves the edge cert on its own port, proxying like the edge mesh vhost', () => {
    const s = renderFrontScript({ domain: 'mesh.lab', port: 443, upstream: '127.0.0.1:8081' });
    expect(s).toContain(`https://mesh.lab:${MESH_FRONT_PORT} {`);
    expect(s).not.toMatch(/:443\b/); // never competes with the edge's host-mode :443
    expect(s).toContain('ls /edge-data/caddy/certificates/*/"$d"/"$d".crt');
    expect(s).toContain('reverse_proxy @grpc h2c://127.0.0.1:8081 {');
    expect(s).toContain('admin off');
  });

  test('the fallback jumps sit AFTER Docker’s, and are removed when the front is not serving', () => {
    const on = renderFrontFallback({ domain: 'mesh.lab', port: 443, upstream: '127.0.0.1:8081' }, true);
    expect(on).toContain('-t nat -A "$C" -p tcp --dport 443 -m addrtype --dst-type LOCAL -j REDIRECT --to-ports 18443');
    expect(on).toContain('"$ipt" -w -t nat -A "$ch" -j "$C"'); // appended, never inserted
    expect(on).not.toContain('-I PREROUTING');
    expect(on).toContain('[ "$pos" -gt "$dpos" ]');
    const off = renderFrontFallback({ domain: 'mesh.lab', port: 443, upstream: '127.0.0.1:8081' }, false);
    expect(off).toContain('-X "$C"');
    expect(off).toContain('if [ "0" = 1 ]; then');
    expect(off).toContain('swarmy-mesh-front-fallback: off');
    expect(renderFrontFallback(null, true)).toContain('fallback: off');
  });
});
