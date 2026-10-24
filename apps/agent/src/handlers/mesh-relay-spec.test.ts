import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshRelaySpec } from '@swarmy/core/protocol';
import { renderMeshFirewallScript } from './mesh-firewall';
import { MESH_RELAY_CONTAINER_LABEL, MESH_RELAY_ENTRYPOINT, relayContainerLabel, relayNeedsRecreate, renderRelayEnv, shQuote } from './mesh-relay-spec';

const spec = MeshRelaySpec.parse({
  image: 'ghcr.io/netbirdio/relay:0.79.0@sha256:0ef3133050c7c5e596ba068d916d3e0f1675ac646d3d169e081331ef3ad2055e',
  exposedAddress: 'rels://relay.198-51-100-10.sslip.io:443',
  authSecret: "s3cret-with-'quote'-and-$HOME-`x`",
});

describe('edge relay container (swarmy-mesh-relay)', () => {
  test('the env file carries every flag, the secret quoted, health on loopback', () => {
    expect(renderRelayEnv(spec)).toBe(
      [
        "NB_LISTEN_ADDRESS=':33080'",
        "NB_EXPOSED_ADDRESS='rels://relay.198-51-100-10.sslip.io:443'",
        `NB_AUTH_SECRET='s3cret-with-'\\''quote'\\''-and-$HOME-\`x\`'`,
        "NB_METRICS_PORT='33082'",
        "NB_HEALTH_LISTEN_ADDRESS='127.0.0.1:33081'",
        "NB_LOG_LEVEL='info'",
        "NB_ENABLE_STUN='true'",
        "NB_STUN_PORTS='3478'",
        '',
      ].join('\n'),
    );
    expect(renderRelayEnv({ ...spec, stun: false })).toContain("NB_ENABLE_STUN='false'");
  });

  test('a real POSIX shell sources it back to the exact values (what the entrypoint does)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-env-'));
    const file = join(dir, 'env');
    writeFileSync(file, renderRelayEnv(spec));
    const r = spawnSync('sh', ['-c', `set -a; . "$1"; set +a; printf '%s|%s|%s' "$NB_AUTH_SECRET" "$NB_EXPOSED_ADDRESS" "$NB_ENABLE_STUN"`, 'sh', file], { encoding: 'utf8' });
    expect(r.stdout).toBe(`${spec.authSecret}|${spec.exposedAddress}|true`);
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  test('the entrypoint waits for the tmpfs env, exports it and execs the relay (PID 1)', () => {
    expect(MESH_RELAY_ENTRYPOINT[0]).toBe('/busybox/sh');
    expect(MESH_RELAY_ENTRYPOINT[2]).toBe(
      'while [ ! -s /run/swarmy-relay/env ]; do sleep 0.2; done; set -a; . /run/swarmy-relay/env; set +a; exec /go/bin/netbird-relay',
    );
  });

  test('re-created only for a new image (or entrypoint); a config change is a restart', () => {
    const label = relayContainerLabel(spec.image);
    expect(relayNeedsRecreate(null, spec.image)).toBe(true);
    expect(relayNeedsRecreate({ Config: { Labels: { [MESH_RELAY_CONTAINER_LABEL]: label } } }, spec.image)).toBe(false);
    expect(relayNeedsRecreate({ Config: { Labels: { [MESH_RELAY_CONTAINER_LABEL]: label } } }, 'ghcr.io/netbirdio/relay:0.80.0')).toBe(true);
    expect(relayNeedsRecreate({ Config: { Labels: null } }, spec.image)).toBe(true);
  });

  test('its own firewall chain drops the plain listener, metrics and health off-host', () => {
    const script = renderMeshFirewallScript([spec.listenPort, spec.metricsPort, spec.healthPort], 'SWARMY-MESH-RELAY');
    expect(script).toContain('C=SWARMY-MESH-RELAY\n');
    expect(script).toContain('-i wt0 -j RETURN');
    expect(script).toContain('-p tcp -m multiport --dports 33080,33082,33081 -j DROP');
    // Never STUN (public, UDP) and never a foreign chain name.
    expect(script).not.toContain('3478');
    expect(renderMeshFirewallScript([1], 'INPUT; rm -rf /')).toContain('C=SWARMY-MESH-CTL\n');
  });
});
