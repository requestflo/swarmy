import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { BLUEPRINT_IDS, BLUEPRINT_STEP_KINDS, type BlueprintParamsInput } from '@swarmy/core';
import { parseQueuesLabel, QUEUES_LABEL } from '../queues.service';
import {
  BLUEPRINT_CATALOG,
  buildCompose,
  buildPlanSummary,
  getBlueprint,
  planStepView,
  secretToken,
  SIZE_PRESETS,
  substituteTokens,
  TOKEN_DB_PASSWORD,
  type PlanStep,
} from './catalog';

function params(over: Partial<BlueprintParamsInput> = {}): BlueprintParamsInput {
  return { name: 'demo', size: 'm', options: {}, ...over };
}

function composeOf(steps: PlanStep[]): string {
  const deploy = steps.find((s) => s.kind === 'stack.deploy');
  if (!deploy || deploy.kind !== 'stack.deploy') throw new Error('no stack.deploy step');
  return deploy.payload.composeSource;
}

describe('catalog — shape invariants for every blueprint', () => {
  it('covers exactly the published ids, uniquely', () => {
    const ids = BLUEPRINT_CATALOG.map((e) => e.meta.id);
    expect([...ids].sort()).toEqual([...BLUEPRINT_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const entry of BLUEPRINT_CATALOG) {
    it(`${entry.meta.id}: plan emits only known step kinds and clean payloads`, () => {
      const steps = entry.plan(params({ domain: 'demo.example.com' }));
      if (entry.meta.docOnly) {
        expect(steps).toEqual([]);
        return;
      }
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(BLUEPRINT_STEP_KINDS).toContain(step.kind);
        expect(step.label.length).toBeGreaterThan(0);
        // Plans are display/persist-safe: no resolved credential can exist yet,
        // and the compose source never carries even a token.
        if (step.kind === 'stack.deploy') {
          expect(step.payload.composeSource).not.toContain('__SWARMY_');
          expect(step.payload.services.length).toBeGreaterThan(0);
          const doc = parseYaml(step.payload.composeSource) as {
            services?: Record<string, { image?: string }>;
          };
          expect(Object.keys(doc.services ?? {})).toEqual(step.payload.services);
          for (const svc of Object.values(doc.services ?? {})) {
            expect(typeof svc.image).toBe('string');
          }
        }
      }
      // Every plan deploys exactly one stack.
      expect(steps.filter((s) => s.kind === 'stack.deploy')).toHaveLength(1);
    });

    it(`${entry.meta.id}: plan-step views never leak values`, () => {
      for (const step of entry.plan(params({ domain: 'demo.example.com' }))) {
        const view = planStepView(step);
        expect(view.kind).toBe(step.kind);
        for (const v of Object.values(view.detail)) expect(v).not.toContain('__SWARMY_');
      }
    });
  }

  it('routes appear only when a domain is given (and never for the worker)', () => {
    for (const entry of BLUEPRINT_CATALOG) {
      const without = entry.plan(params());
      expect(without.some((s) => s.kind === 'ingress.route')).toBe(false);
      const withDomain = entry.plan(params({ domain: 'x.example.com' }));
      const hasRoute = withDomain.some((s) => s.kind === 'ingress.route');
      expect(hasRoute).toBe(entry.meta.supportsDomain && !entry.meta.docOnly);
    }
  });
});

describe('node-api', () => {
  it('provisions a db by default, sized by the t-shirt size', () => {
    for (const [size, preset] of Object.entries(SIZE_PRESETS)) {
      const steps = getBlueprint('node-api').plan(params({ size: size as 's' | 'm' | 'l' }));
      const db = steps.find((s) => s.kind === 'db.provision');
      expect(db).toBeDefined();
      if (db?.kind === 'db.provision') expect(db.payload.replicas).toBe(preset.dbReplicas);
    }
  });

  it('drops the db (and its wire) when database=false', () => {
    const steps = getBlueprint('node-api').plan(params({ options: { database: false } }));
    expect(steps.some((s) => s.kind === 'db.provision')).toBe(false);
    const deploy = steps.find((s) => s.kind === 'stack.deploy');
    if (deploy?.kind === 'stack.deploy') expect(deploy.payload.wires).toEqual([]);
  });

  it('routes the API port from options', () => {
    const steps = getBlueprint('node-api').plan(
      params({ domain: 'api.example.com', options: { port: '8080' } }),
    );
    const route = steps.find((s) => s.kind === 'ingress.route');
    if (route?.kind === 'ingress.route') {
      expect(route.payload).toEqual({ service: 'demo-api', host: 'api.example.com', port: 8080 });
    } else {
      throw new Error('missing route step');
    }
  });
});

describe('wordpress', () => {
  const steps = getBlueprint('wordpress').plan(params({ name: 'blog', domain: 'blog.example.com' }));

  it('is secret → stack (db+wp) → route', () => {
    expect(steps.map((s) => s.kind)).toEqual(['secret', 'stack.deploy', 'ingress.route']);
  });

  it('wires the db password by *_FILE secret, never via env or compose', () => {
    const deploy = steps[1];
    if (deploy?.kind !== 'stack.deploy') throw new Error('bad shape');
    expect(deploy.payload.wires).toEqual([
      { type: 'secret', service: 'blog-db', family: 'blog-db-password', envName: 'MARIADB_PASSWORD_FILE' },
      { type: 'secret', service: 'blog-wordpress', family: 'blog-db-password', envName: 'WORDPRESS_DB_PASSWORD_FILE' },
    ]);
    // No password VALUE anywhere in the compose: the only password-ish env is
    // the MARIADB_RANDOM_ROOT_PASSWORD=1 toggle; the real one rides *_FILE.
    const doc = parseYaml(deploy.payload.composeSource) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(doc.services['blog-db']?.environment?.MARIADB_PASSWORD).toBeUndefined();
    expect(doc.services['blog-wordpress']?.environment?.WORDPRESS_DB_PASSWORD).toBeUndefined();
  });

  it('declares persistent volumes and a shared overlay network', () => {
    const doc = parseYaml(composeOf(steps)) as {
      services: Record<string, { volumes?: string[]; networks?: string[] }>;
      volumes?: Record<string, unknown>;
    };
    expect(doc.services['blog-db']?.volumes).toEqual(['blog-db-data:/var/lib/mysql']);
    expect(doc.services['blog-wordpress']?.networks).toEqual(['blog-net']);
    expect(Object.keys(doc.volumes ?? {})).toContain('blog-wp-content');
  });

  it('golden summary', () => {
    expect(buildPlanSummary('blog', steps)).toBe(
      'Will create: secret blog-db-password, stack blog (2 services), route blog.example.com.',
    );
  });
});

describe('n8n', () => {
  const steps = getBlueprint('n8n').plan(params({ domain: 'n8n.example.com' }));

  it('is db → secret → stack → route', () => {
    expect(steps.map((s) => s.kind)).toEqual(['db.provision', 'secret', 'stack.deploy', 'ingress.route']);
  });

  it('points at the managed primary and wires key-file + db password', () => {
    const doc = parseYaml(composeOf(steps)) as {
      services: Record<string, { environment?: Record<string, string>; networks?: string[] }>;
    };
    const app = doc.services['demo-n8n'];
    expect(app?.environment?.DB_POSTGRESDB_HOST).toBe('demo_db-primary');
    expect(app?.environment?.DB_POSTGRESDB_PASSWORD).toBeUndefined();
    expect(app?.networks).toEqual(['demo_db-net']);

    const deploy = steps[2];
    if (deploy?.kind !== 'stack.deploy') throw new Error('bad shape');
    expect(deploy.payload.wires).toEqual([
      { type: 'secret', service: 'demo-n8n', family: 'demo-encryption-key', envName: 'N8N_ENCRYPTION_KEY_FILE' },
      { type: 'env', service: 'demo-n8n', env: { DB_POSTGRESDB_PASSWORD: TOKEN_DB_PASSWORD } },
    ]);
  });
});

describe('worker-with-queue', () => {
  it('sizes the cache and the autoscale ceiling by t-shirt size', () => {
    const small = getBlueprint('worker-with-queue').plan(params({ size: 's' }));
    const cacheS = small[0];
    if (cacheS?.kind !== 'cache.provision') throw new Error('bad shape');
    expect(cacheS.payload).toMatchObject({ topology: 'single', memoryMb: 128, replicas: 0 });

    const large = getBlueprint('worker-with-queue').plan(params({ size: 'l' }));
    const cacheL = large[0];
    if (cacheL?.kind !== 'cache.provision') throw new Error('bad shape');
    expect(cacheL.payload).toMatchObject({ topology: 'replica', memoryMb: 1024, replicas: 2 });
  });

  it('stamps a parseable swarmy.queues label on the worker', () => {
    const steps = getBlueprint('worker-with-queue').plan(
      params({ size: 'm', options: { queue: 'emails' } }),
    );
    const deploy = steps.find((s) => s.kind === 'stack.deploy');
    if (deploy?.kind !== 'stack.deploy') throw new Error('bad shape');
    const raw = deploy.payload.postLabels['demo-worker']?.[QUEUES_LABEL];
    const defs = parseQueuesLabel(raw);
    expect(defs).toEqual([
      {
        name: 'emails',
        cacheCluster: 'cache',
        convention: 'bullmq',
        scalePerJobs: 25,
        minWorkers: 1,
        maxWorkers: SIZE_PRESETS.m.maxWorkers,
        retries: 3,
        dlq: true,
      },
    ]);
    expect(deploy.payload.wires).toEqual([
      { type: 'cache', service: 'demo-worker', cluster: 'cache', envVar: 'REDIS_URL' },
    ]);
  });

  it('never emits a route (headless), even when a domain is passed', () => {
    const steps = getBlueprint('worker-with-queue').plan(params({ domain: 'w.example.com' }));
    expect(steps.some((s) => s.kind === 'ingress.route')).toBe(false);
  });
});

describe('directus', () => {
  it('reveals the generated admin password once, via token substitution', () => {
    const steps = getBlueprint('directus').plan(params({ options: { adminEmail: 'ops@acme.io' } }));
    const admin = steps.find(
      (s) => s.kind === 'secret' && s.payload.family === 'demo-admin-password',
    );
    if (admin?.kind !== 'secret') throw new Error('missing admin secret step');
    expect(admin.payload.token).toBe(secretToken('demo-admin-password'));
    expect(admin.payload.revealNote).toContain('ops@acme.io');
    expect(admin.payload.revealNote).toContain(admin.payload.token as string);
  });

  it('adds a bucket step + attach wire only when s3Uploads is on', () => {
    const off = getBlueprint('directus').plan(params());
    expect(off.some((s) => s.kind === 'bucket')).toBe(false);
    const on = getBlueprint('directus').plan(params({ options: { s3Uploads: true } }));
    expect(on.some((s) => s.kind === 'bucket')).toBe(true);
    const deploy = on.find((s) => s.kind === 'stack.deploy');
    if (deploy?.kind !== 'stack.deploy') throw new Error('bad shape');
    expect(deploy.payload.wires).toContainEqual({
      type: 'bucket',
      service: 'demo-directus',
      bucket: 'demo-uploads',
    });
  });
});

describe('pure helpers', () => {
  it('substituteTokens replaces every occurrence and leaves unknowns intact', () => {
    const out = substituteTokens('a=__T__ b=__T__ c=__UNKNOWN__', { __T__: 'x' });
    expect(out).toBe('a=x b=x c=__UNKNOWN__');
  });

  it('secretToken normalizes family names', () => {
    expect(secretToken('blog-db-password')).toBe('__SWARMY_SECRET_BLOG_DB_PASSWORD__');
  });

  it('buildCompose emits compose-parseable YAML with deploy.replicas', () => {
    const doc = parseYaml(
      buildCompose({ web: { image: 'nginx:1.27-alpine', replicas: 3, networks: ['net-a'] } }),
    ) as {
      services: Record<string, { image: string; deploy?: { replicas?: number } }>;
      networks?: Record<string, { driver?: string }>;
    };
    expect(doc.services.web?.image).toBe('nginx:1.27-alpine');
    expect(doc.services.web?.deploy?.replicas).toBe(3);
    expect(doc.networks?.['net-a']?.driver).toBe('overlay');
  });

  it('doc-only summary reads as documentation', () => {
    expect(buildPlanSummary('x', [])).toBe('Nothing to deploy — this blueprint is documentation.');
  });
});
