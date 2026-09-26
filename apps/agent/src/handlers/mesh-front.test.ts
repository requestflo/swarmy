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

describe('mesh front never wedges (QA-072)', () => {
  const f = { domain: 'mesh.lab', port: 443, upstream: '127.0.0.1:8081' };

  test('Caddy gets a bounded grace, and the stop SIGKILLs after it', async () => {
    const { FRONT_GRACE_S } = await import('./mesh-front');
    const s = renderFrontScript(f);
    expect(s).toContain(`  grace_period ${FRONT_GRACE_S}s`);
    // No bare `wait "$pid"`: that is what sat forever behind the eternal grace.
    expect(s).not.toMatch(/kill "\$pid"; wait "\$pid"/);
    expect(s).toContain('kill -9 "$pid"');
    expect(s).toContain(`[ "$i" -lt ${FRONT_GRACE_S + 5} ]`);
    expect(s).toContain('trap stop TERM INT');
  });

  test('a Running front that fails 3 probes in a row is re-created, at most once per window', async () => {
    const { frontNeedsRecreate, FRONT_RECREATE_EVERY_MS } = await import('./mesh-front');
    const now = 10 * FRONT_RECREATE_EVERY_MS;
    expect(frontNeedsRecreate(0, 0, now)).toBe(false);
    expect(frontNeedsRecreate(2, 0, now)).toBe(false);
    expect(frontNeedsRecreate(3, 0, now)).toBe(true);
    expect(frontNeedsRecreate(7, now - 1_000, now)).toBe(false);
    expect(frontNeedsRecreate(7, now - FRONT_RECREATE_EVERY_MS, now)).toBe(true);
  });
});

describe('agent-managed containers roll onto a new script (QA-077)', () => {
  const f = { domain: 'mesh.lab', port: 443, upstream: '127.0.0.1:8081' };
  const IMG = 'ghcr.io/requestflo/caddy-swarmy@sha256:aaaa';
  const cfg = `# x\n{ "server": { "exposedAddress": "https://mesh.lab:443", "listenAddress": ":8081" } }`;

  /** A docker fake holding one front container with `label`; records creates. */
  function fakeDocker(label: string | null) {
    const created: unknown[] = [];
    const removed: string[] = [];
    const docker = {
      docker: {
        getContainer: (name: string) => ({
          inspect: async () => {
            if (label === null) throw new Error('no such container');
            return { Config: { Labels: { 'swarmy.mesh.front.spec': label }, Image: IMG }, State: { Running: true } };
          },
          remove: async () => void removed.push(name),
          start: async () => undefined,
        }),
        listContainers: async () => [{ Image: IMG, Created: 1 }],
        createContainer: async (o: unknown) => {
          created.push(o);
          return { start: async () => undefined };
        },
      },
    };
    return { docker: docker as never, created, removed };
  }

  test('the label covers the script and the image', async () => {
    const { frontSpecLabel } = await import('./mesh-front');
    expect(frontSpecLabel(f, IMG)).toBe(frontSpecLabel(f, IMG));
    expect(frontSpecLabel(f, IMG, 'the QA-072 script')).not.toBe(frontSpecLabel(f, IMG));
    expect(frontSpecLabel(f, `${IMG}b`)).not.toBe(frontSpecLabel(f, IMG));
  });

  test('a front running an older script is re-created; an up-to-date one is kept', async () => {
    const { ensureMeshFront, frontSpecLabel } = await import('./mesh-front');
    const old = fakeDocker(frontSpecLabel(f, IMG, 'the QA-072 script'));
    await ensureMeshFront(old.docker, cfg, () => undefined);
    expect(old.created).toHaveLength(1);
    expect((old.created[0] as { Labels: Record<string, string> }).Labels['swarmy.mesh.front.spec']).toBe(frontSpecLabel(f, IMG));

    const cur = fakeDocker(frontSpecLabel(f, IMG));
    await ensureMeshFront(cur.docker, cfg, () => undefined);
    expect(cur.created).toHaveLength(0);
    expect(cur.removed).toHaveLength(0);

    // The pre-QA-077 label (the bare spec JSON) rolls once.
    const legacy = fakeDocker(JSON.stringify(f));
    await ensureMeshFront(legacy.docker, cfg, () => undefined);
    expect(legacy.created).toHaveLength(1);
  });

  test('the Litestream sidecar label covers its entrypoint too', async () => {
    const { litestreamSpecLabel } = await import('./mesh-control');
    const ls = { image: 'litestream/litestream:0.3.13', env: { A: '1' }, network: 'swarmy-control' };
    expect(litestreamSpecLabel(ls)).toBe(litestreamSpecLabel({ ...ls }));
    const { createHash } = await import('node:crypto');
    const preFix = createHash('sha256').update(JSON.stringify({ image: ls.image, env: ls.env, network: ls.network })).digest('hex');
    expect(litestreamSpecLabel(ls)).not.toBe(preFix);
  });
});
