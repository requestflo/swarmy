import { describe, expect, it } from 'bun:test';
import { composeToStack, ComposeStackError } from './to-stack';

/**
 * Golden: compose → the namespaced specs `docker stack deploy` semantics
 * produce. Defends the launch blocker — named volumes persist (`<stack>_<vol>`),
 * services never clobber across stacks (`<stack>_<svc>`), and in-stack DNS
 * works (`<stack>_default` + short-name alias).
 */

const APP = {
  services: {
    web: {
      image: 'ghcr.io/acme/web:1.2.0',
      environment: { DATABASE_HOST: 'db' },
      ports: ['8080:80'],
      networks: ['front', 'default'],
      deploy: { replicas: 2, labels: { 'swarmy.ingress': 'true' } },
      healthcheck: {
        test: ['CMD', 'wget', '-qO-', 'http://localhost/'],
        interval: '10s',
        retries: 3,
      },
    },
    db: {
      image: 'postgres:16',
      environment: ['POSTGRES_PASSWORD_FILE=/run/secrets/pg'],
      volumes: [
        'pgdata:/var/lib/postgresql/data',
        'shared:/backups',
        './init:/docker-entrypoint-initdb.d:ro',
      ],
      secrets: ['pg'],
    },
  },
  volumes: { pgdata: null, shared: { external: true } },
  networks: { front: { driver: 'overlay' } },
  secrets: { pg: { external: true } },
};

describe('composeToStack — golden 2-service app', () => {
  const plan = composeToStack(APP, 'shop');

  it('produces the exact stack-namespaced specs', () => {
    expect(plan.specs).toEqual([
      {
        name: 'shop_web',
        image: 'ghcr.io/acme/web:1.2.0',
        mode: { replicated: { replicas: 2 } },
        env: { DATABASE_HOST: 'db' },
        labels: { 'swarmy.ingress': 'true', 'com.docker.stack.namespace': 'shop' },
        ports: [{ target: 80, published: 8080, protocol: 'tcp', mode: 'ingress' }],
        networks: ['shop_front', 'shop_default'],
        networkAliases: { shop_front: ['web'], shop_default: ['web'] },
        healthcheck: {
          test: ['CMD', 'wget', '-qO-', 'http://localhost/'],
          intervalNs: 10_000_000_000,
          retries: 3,
        },
      },
      {
        name: 'shop_db',
        image: 'postgres:16',
        mode: { replicated: { replicas: 1 } },
        env: { POSTGRES_PASSWORD_FILE: '/run/secrets/pg' },
        labels: { 'com.docker.stack.namespace': 'shop' },
        mounts: [
          {
            type: 'volume',
            source: 'shop_pgdata',
            target: '/var/lib/postgresql/data',
            readOnly: false,
          },
          { type: 'volume', source: 'shared', target: '/backups', readOnly: false },
          { type: 'bind', source: './init', target: '/docker-entrypoint-initdb.d', readOnly: true },
        ],
        networks: ['shop_default'],
        networkAliases: { shop_default: ['db'] },
        secrets: [{ source: 'pg' }],
      },
    ]);
  });

  it('lists the networks to ensure (declared + default, never external)', () => {
    expect(plan.networks).toEqual([
      {
        name: 'shop_front',
        driver: 'overlay',
        attachable: true,
        labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.managed': 'true' },
      },
      {
        name: 'shop_default',
        driver: 'overlay',
        attachable: true,
        labels: { 'com.docker.stack.namespace': 'shop', 'swarmy.managed': 'true' },
      },
    ]);
    expect(plan.services).toEqual([
      { short: 'web', name: 'shop_web' },
      { short: 'db', name: 'shop_db' },
    ]);
    expect(plan.warnings).toEqual([]);
  });
});

describe('composeToStack — naming', () => {
  const compose = { services: { web: { image: 'nginx:1.27-alpine' } } };

  it('two stacks with the same service name get distinct services + networks', () => {
    const a = composeToStack(compose, 'a');
    const b = composeToStack(compose, 'b');
    expect(a.specs[0]!.name).toBe('a_web');
    expect(b.specs[0]!.name).toBe('b_web');
    expect(a.specs[0]!.networks).toEqual(['a_default']);
    expect(b.specs[0]!.networks).toEqual(['b_default']);
    // Both still answer to `web` — but only inside their own stack's overlay.
    expect(a.specs[0]!.networkAliases).toEqual({ a_default: ['web'] });
    expect(b.specs[0]!.networkAliases).toEqual({ b_default: ['web'] });
  });

  it('a service with no networks still joins <stack>_default (so siblings resolve)', () => {
    expect(composeToStack(compose, 'site').specs[0]).toMatchObject({
      name: 'site_web',
      networks: ['site_default'],
      networkAliases: { site_default: ['web'] },
    });
  });

  it('external / explicitly-named networks + volumes keep their names; compose aliases are added', () => {
    const plan = composeToStack(
      {
        services: {
          api: {
            image: 'api:1',
            networks: { edge: { aliases: ['backend'] }, data: null },
            volumes: ['cache:/cache'],
          },
        },
        networks: { edge: { external: true }, data: { name: 'shared-data' } },
        volumes: { cache: { name: 'legacy-cache' } },
      },
      'x',
    );
    expect(plan.specs[0]!.networks).toEqual(['edge', 'shared-data']);
    expect(plan.specs[0]!.networkAliases).toEqual({
      edge: ['api', 'backend'],
      'shared-data': ['api'],
    });
    expect(plan.specs[0]!.mounts?.[0]?.source).toBe('legacy-cache');
    expect(plan.networks.map((n) => n.name)).toEqual(['shared-data']);
  });

  it('warns on an undeclared volume / file-sourced secret, but still namespaces them', () => {
    const plan = composeToStack(
      {
        services: { w: { image: 'w:1', volumes: ['data:/d'], secrets: ['key'] } },
        secrets: { key: { file: './key.txt' } },
      },
      's',
    );
    expect(plan.specs[0]!.mounts?.[0]?.source).toBe('s_data');
    expect(plan.specs[0]!.secrets).toEqual([{ source: 's_key' }]);
    expect(plan.warnings.map((w) => w.code)).toEqual([
      'undeclared-volume',
      'secret-source-unsupported',
    ]);
  });

  it('refuses a build-only service and an over-long name', () => {
    expect(() => composeToStack({ services: { web: { build: '.' } } }, 's')).toThrow(
      ComposeStackError,
    );
    expect(() =>
      composeToStack({ services: { ['x'.repeat(60)]: { image: 'i' } } }, 'stack'),
    ).toThrow(ComposeStackError);
    expect(() => composeToStack({ services: {} }, 's')).toThrow(ComposeStackError);
  });
});

describe('composeToStack — legacy migration', () => {
  it('keeps mounting a legacy bare-named service volume at the same target', () => {
    const plan = composeToStack(APP, 'shop', {
      legacyVolumes: { db: { '/var/lib/postgresql/data': 'pgdata' } },
    });
    const db = plan.specs.find((s) => s.name === 'shop_db')!;
    expect(db.mounts?.[0]).toEqual({
      type: 'volume',
      source: 'pgdata',
      target: '/var/lib/postgresql/data',
      readOnly: false,
    });
    expect(plan.warnings.map((w) => w.code)).toEqual(['legacy-volume-reused']);
  });

  it('a legacy volume on another target does not hijack the new mount', () => {
    const plan = composeToStack(APP, 'shop', { legacyVolumes: { db: { '/elsewhere': 'old' } } });
    expect(plan.specs.find((s) => s.name === 'shop_db')!.mounts?.[0]?.source).toBe('shop_pgdata');
  });
});

/**
 * Network wall (security): an app may attach to the shared `swarmy` platform
 * network (routed services meet the edge there) but may never register a DNS
 * alias on it — `postgres`/`swarmy_controller` aliases would let it impersonate
 * platform names to the dual-homed edge/collector/agent — and may never join
 * the private `swarmy-control` network at all.
 */
describe('composeToStack — platform network wall', () => {
  it('attaches to external `swarmy` with NO aliases (warned), keeps short alias on the app net', () => {
    const plan = composeToStack(
      {
        services: {
          postgres: {
            image: 'postgres:16',
            networks: { default: {}, swarmy: { aliases: ['swarmy_controller'] } },
          },
        },
        networks: { swarmy: { external: true } },
      },
      'evil',
    );
    const spec = plan.specs[0]!;
    expect(spec.networks).toEqual(['evil_default', 'swarmy']);
    expect(spec.networkAliases).toEqual({ evil_default: ['postgres'] });
    expect(plan.networks.map((n) => n.name)).toEqual(['evil_default']);
    expect(plan.warnings.some((w) => w.code === 'platform-network-alias-dropped')).toBe(true);
  });

  it('a non-external network NAMED `swarmy` is never (re)declared by the stack', () => {
    const plan = composeToStack(
      { services: { web: { image: 'nginx', networks: ['edge'] } }, networks: { edge: { name: 'swarmy' } } },
      'shop',
    );
    expect(plan.networks).toEqual([]);
    expect(plan.specs[0]!.networkAliases).toEqual({});
  });

  it('refuses `swarmy-control`, external or by name', () => {
    for (const decl of [{ external: true, name: 'swarmy-control' }, { name: 'swarmy-control' }]) {
      expect(() =>
        composeToStack(
          { services: { web: { image: 'nginx', networks: ['ctl'] } }, networks: { ctl: decl } },
          'shop',
        ),
      ).toThrow(ComposeStackError);
    }
  });

  it('carries compose driver_opts onto the declared network', () => {
    const plan = composeToStack(
      {
        services: { web: { image: 'nginx', networks: ['front'] } },
        networks: { front: { driver_opts: { encrypted: '', 'com.docker.network.driver.mtu': '1200' } } },
      },
      'shop',
    );
    expect(plan.networks[0]!.options).toEqual({ encrypted: '', 'com.docker.network.driver.mtu': '1200' });
  });
});
