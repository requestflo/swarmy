import { describe, expect, it } from 'bun:test';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { isKeySecretOf } from './search.service';
import { keySecretVersion, olderKeySecrets, rotateSearchKey } from './search-key.service';
import { ENGINE, ctxWith } from './search-testing';

const FAMILY = 'swarmy-search-shop_main-key';
const APP = {
  ...ENGINE,
  id: 'svc-web', name: 'shop_web', image: 'shop/web:1',
  labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.search.inject': 'main', 'swarmy.search.inject.var': 'MEILI_HOST' },
};

/** A Docker inspect payload: name, image, env, labels, secret refs (source → file target). */
function inspect(name: string, image: string, labels: Record<string, string>, env: string[], secrets: Array<[string, string]>) {
  return {
    inspect: {
      Spec: {
        Name: name,
        Labels: labels,
        Mode: { Replicated: { Replicas: 1 } },
        TaskTemplate: {
          ContainerSpec: { Image: image, Env: env, Secrets: secrets.map(([s, t]) => ({ SecretName: s, File: { Name: t } })) },
        },
      },
    },
  };
}

function rig(engineLabels: Record<string, string> = {}, failApp = false) {
  const deployed: ServiceSpec[] = [];
  const removed: string[] = [];
  const created: string[] = [];
  const current = engineLabels['swarmy.search.keySecret'] ?? FAMILY;
  const t = ctxWith('owner', () => [], {
    labels: engineLabels,
    services: [APP],
    onCommand: (cmd, p) => {
      if (cmd === 'secret.create') return void created.push(String(p.name));
      if (cmd === 'secret.remove') return void removed.push(String(p.name));
      if (cmd === 'service.inspect') {
        return p.service === 'shop_web'
          ? inspect('shop_web', 'shop/web:1', APP.labels, [`MEILI_HOST=http://shop_main-search:7700`, `MEILI_MASTER_KEY_FILE=/run/secrets/${FAMILY}`], [[current, FAMILY]])
          : inspect('shop_main-search', ENGINE.image, { ...ENGINE.labels, ...engineLabels }, [], [[current, 'search-master-key']]);
      }
      if (cmd === 'service.deploy') {
        const spec = (p as { spec: ServiceSpec }).spec;
        if (failApp && spec.name === 'shop_web') throw new Error('E_DOCKER: update out of sequence');
        deployed.push(spec);
      }
      return undefined;
    },
  });
  return { ...t, deployed, removed, created };
}

describe('search key rotation', () => {
  it('names versions the way the secret families do', () => {
    expect(keySecretVersion(FAMILY, FAMILY)).toBe(1);
    expect(keySecretVersion(`${FAMILY}__v4`, FAMILY)).toBe(4);
    expect(olderKeySecrets(FAMILY, 4)).toEqual([FAMILY, `${FAMILY}__v2`, `${FAMILY}__v3`]);
    const ours = isKeySecretOf('shop', 'main');
    expect([FAMILY, `${FAMILY}__v2`, `${FAMILY}x`, 'swarmy-search-shop_main2-key__v2'].map(ours)).toEqual([true, true, false, false]);
  });

  it('mints v2, restarts the engine on it, moves the app at the same file path, drops v1', async () => {
    const r = rig();
    const out = await rotateSearchKey(r.ctx, { stack: 'shop', name: 'main' });
    expect(r.created).toEqual([`${FAMILY}__v2`]);
    const [engine, app] = r.deployed;
    expect(engine!.name).toBe('shop_main-search');
    expect(engine!.secrets).toEqual([{ source: `${FAMILY}__v2`, target: 'search-master-key' }]);
    expect(engine!.labels?.['swarmy.search.keySecret']).toBe(`${FAMILY}__v2`);
    expect(app!.secrets).toEqual([{ source: `${FAMILY}__v2`, target: FAMILY }]);
    expect(app!.env?.MEILI_MASTER_KEY_FILE).toBe(`/run/secrets/${FAMILY}`);
    expect(r.removed).toEqual([FAMILY]);
    expect(out).toMatchObject({ keySecret: `${FAMILY}__v2`, version: 2, redeployed: ['shop_main-search', 'shop_web'], failed: [] });
    expect(out.masterKey).toMatch(/^[A-Za-z0-9]{20,}$/);
    expect(r.audit.map((a) => a.action)).toEqual(['search.key.rotate']);
    expect(JSON.stringify(r.audit[0]!.metadata)).not.toContain(out.masterKey);
  });

  it('a second rotation goes v2 → v3 and clears both older versions', async () => {
    const r = rig({ 'swarmy.search.keySecret': `${FAMILY}__v2` });
    expect((await rotateSearchKey(r.ctx, { stack: 'shop', name: 'main' })).version).toBe(3);
    expect(r.removed).toEqual([FAMILY, `${FAMILY}__v2`]);
  });

  it('an app that will not move is reported, and the one-time key is still returned', async () => {
    const r = rig({}, true);
    const out = await rotateSearchKey(r.ctx, { stack: 'shop', name: 'main' });
    expect(out.redeployed).toEqual(['shop_main-search']);
    expect(out.failed).toEqual([{ service: 'shop_web', error: expect.stringContaining('out of sequence') }]);
    expect(out.masterKey.length).toBeGreaterThan(0);
  });
});
