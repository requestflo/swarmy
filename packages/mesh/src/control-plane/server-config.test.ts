import { describe, expect, test } from 'bun:test';
import {
  meshControlIssuer,
  meshControlOidcCallback,
  meshControlPublicUrl,
  renderMeshControlConfig,
  type MeshControlConfigInput,
} from './server-config';
import { netbirdLitestreamDbs, renderLitestreamConfig } from './litestream';

const base: MeshControlConfigInput = {
  meshDomain: 'mesh.example.com',
  tls: { mode: 'edge', listen: '172.18.0.1:8081' },
  authSecret: 'relay-secret-0123456789',
  encryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  localAuthDisabled: true,
  trustedProxies: ['172.18.0.0/16'],
};

describe('renderMeshControlConfig (golden)', () => {
  test('behind the edge: plain HTTP on the gwbridge, https exposed, no default-policy key', () => {
    expect(renderMeshControlConfig(base)).toBe(`# swarmy-managed NetBird control plane — rendered, do not edit.
{
  "server": {
    "auth": {
      "cliRedirectURIs": [
        "http://localhost:53000/",
        "http://localhost:54000/"
      ],
      "issuer": "https://mesh.example.com/oauth2",
      "localAuthDisabled": true,
      "signKeyRefreshEnabled": true
    },
    "authSecret": "relay-secret-0123456789",
    "dataDir": "/var/lib/netbird/",
    "disableAnonymousMetrics": true,
    "disableGeoliteUpdate": true,
    "exposedAddress": "https://mesh.example.com:443",
    "healthcheckAddress": "127.0.0.1:9000",
    "listenAddress": "172.18.0.1:8081",
    "logFile": "console",
    "logLevel": "info",
    "metricsPort": 9090,
    "reverseProxy": {
      "trustedHTTPProxies": [
        "172.18.0.0/16"
      ]
    },
    "store": {
      "encryptionKey": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      "engine": "sqlite"
    },
    "stunPorts": [
      3478
    ]
  }
}
`);
  });

  test("first boot on a public box: NetBird's own ACME on :443", () => {
    const out = JSON.parse(renderMeshControlConfig({ ...base, tls: { mode: 'letsencrypt', email: 'ops@example.com' }, localAuthDisabled: false, trustedProxies: [] }).split('\n').slice(1).join('\n'));
    expect(out.server.listenAddress).toBe(':443');
    expect(out.server.tls).toEqual({ letsencrypt: { enabled: true, dataDir: '/var/lib/netbird/letsencrypt', domains: ['mesh.example.com'], email: 'ops@example.com' } });
    expect(out.server.auth.localAuthDisabled).toBe(false);
    expect(out.server.reverseProxy).toBeUndefined();
    expect('disableDefaultPolicy' in out.server).toBe(false);
  });

  test('lab: plain HTTP on a port, and every URL follows', () => {
    const tls = { mode: 'none', port: 8081 } as const;
    const out = JSON.parse(renderMeshControlConfig({ ...base, meshDomain: 'mesh-192-168-64-5.sslip.io', tls }).split('\n').slice(1).join('\n'));
    expect(out.server.exposedAddress).toBe('http://mesh-192-168-64-5.sslip.io:8081');
    expect(out.server.listenAddress).toBe(':8081');
    expect(meshControlPublicUrl('m.x', tls)).toBe('http://m.x:8081');
    expect(meshControlIssuer('m.x', tls)).toBe('http://m.x:8081/oauth2');
    expect(meshControlOidcCallback('m.x', { mode: 'edge', listen: 'x' })).toBe('https://m.x/oauth2/callback');
  });

  test('behind a proxy on another port: every URL carries it', () => {
    const tls = { mode: 'edge', listen: '172.17.0.1:8081', publicPort: 8444 } as const;
    const out = JSON.parse(renderMeshControlConfig({ ...base, tls }).split('\n').slice(1).join('\n'));
    expect(out.server.exposedAddress).toBe('https://mesh.example.com:8444');
    expect(out.server.auth.issuer).toBe('https://mesh.example.com:8444/oauth2');
    expect(meshControlOidcCallback('mesh.example.com', tls)).toBe('https://mesh.example.com:8444/oauth2/callback');
  });

  test('refuses bad input', () => {
    expect(() => renderMeshControlConfig({ ...base, meshDomain: 'https://mesh.x' })).toThrow(/invalid mesh domain/);
    expect(() => renderMeshControlConfig({ ...base, authSecret: 'short' })).toThrow(/authSecret/);
    expect(() => renderMeshControlConfig({ ...base, encryptionKey: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});

describe('renderLitestreamConfig (golden)', () => {
  test('one replica path per NetBird DB, no credentials', () => {
    const cfg = renderLitestreamConfig({
      dbs: netbirdLitestreamDbs({ dataDir: '/var/lib/netbird/', bucket: 'swarmy-mesh', prefix: '/cid123/netbird/', endpoint: 'http://swarmy-garage:3900', region: 'garage' }),
      socketPath: '/run/swarmy-litestream/litestream.sock',
    });
    expect(cfg).toContain('  - path: "/var/lib/netbird/events.db"');
    expect(cfg).toContain('      path: "cid123/netbird/store"');
    expect(cfg).toContain('      path: "cid123/netbird/idp"');
    expect(cfg.indexOf('events.db')).toBeLessThan(cfg.indexOf('idp.db'));
    expect(cfg).not.toMatch(/secret|access-key/i);
    expect(cfg.split('\n').filter((l) => l.includes('sync-interval: 1s'))).toHaveLength(3);
  });
  test('two DBs on one replica path is refused', () => {
    const r = { bucket: 'b', path: 'p', endpoint: 'e', region: 'r' };
    expect(() => renderLitestreamConfig({ dbs: [{ path: '/a.db', replica: r }, { path: '/b.db', replica: r }], socketPath: '/s' })).toThrow(/share the replica path/);
  });
});

describe('parseMeshTlsEnv (installer → controller)', () => {
  test('every shape the installer writes', async () => {
    const { parseMeshTlsEnv } = await import('./server-config');
    expect(parseMeshTlsEnv(undefined)).toEqual({ tls: { mode: 'letsencrypt' } });
    expect(parseMeshTlsEnv('none:8081')).toEqual({ tls: { mode: 'none', port: 8081 } });
    expect(parseMeshTlsEnv('edge=172.17.0.1:8081')).toEqual({ tls: { mode: 'edge', listen: '172.17.0.1:8081' } });
    expect(parseMeshTlsEnv('edge=172.17.0.1:8081@8444;bootstrap=none:8081')).toEqual({
      tls: { mode: 'edge', listen: '172.17.0.1:8081', publicPort: 8444 },
      bootstrapTls: { mode: 'none', port: 8081 },
    });
    expect(parseMeshTlsEnv('edge=172.17.0.1:8081@443;bootstrap=none:8081').tls).toEqual({ mode: 'edge', listen: '172.17.0.1:8081' });
  });
});
