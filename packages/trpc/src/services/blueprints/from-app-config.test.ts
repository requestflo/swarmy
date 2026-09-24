import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { BLUEPRINT_STEP_KINDS, type BlueprintParamsInput } from '@swarmy/core';
import { composeToModels, composeToStack, validateModel } from '@swarmy/core/compose';
import { APP_TEMPLATES, findAppTemplate } from '@swarmy/templates';
import {
  BLUEPRINT_CATALOG,
  planStepView,
  secretToken,
  TOKEN_DB_HOST,
  TOKEN_DB_NAME,
  TOKEN_DB_PASSWORD,
  TOKEN_DB_URL,
  TOKEN_REDIS_PASSWORD,
  TOKEN_REDIS_URL,
  type PlanStep,
} from './catalog';
import { compileTemplate, TEMPLATE_ENTRIES, templateSecretFamily } from './from-app-config';
import { ALL_BLUEPRINTS, findBlueprint } from './registry';

/**
 * The launch gate for the one-click catalogue: EVERY template compiles for
 * every size, with and without a domain, into a compose document that the
 * real deploy pipeline (`composeToStack` + `validateModel`) accepts, and whose
 * persisted source never carries a credential or even a token.
 */

function params(over: Partial<BlueprintParamsInput> = {}): BlueprintParamsInput {
  return { name: 'demo', size: 'm', options: {}, ...over };
}

const FIXED_TOKENS = [
  TOKEN_DB_URL,
  TOKEN_DB_HOST,
  TOKEN_DB_PASSWORD,
  TOKEN_DB_NAME,
  TOKEN_REDIS_URL,
  TOKEN_REDIS_PASSWORD,
];

function deployOf(steps: PlanStep[]): Extract<PlanStep, { kind: 'stack.deploy' }> {
  const d = steps.find((s) => s.kind === 'stack.deploy');
  if (!d || d.kind !== 'stack.deploy') throw new Error('no stack.deploy step');
  return d;
}

describe('registry', () => {
  it('has at least 50 one-click apps and no id collides with a built-in', () => {
    expect(TEMPLATE_ENTRIES.length).toBeGreaterThanOrEqual(1);
    const ids = ALL_BLUEPRINTS.map((e) => e.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BLUEPRINT_CATALOG) expect(findAppTemplate(b.meta.id)).toBeUndefined();
    expect(findBlueprint('nope')).toBeUndefined();
  });
});

describe('every template through the compose/model pipeline', () => {
  const variants: Array<[string, BlueprintParamsInput, { autoHost?: string | null }]> = [
    ['m + domain', params({ domain: 'app.example.com' }), {}],
    ['s + auto address', params({ size: 's' }), { autoHost: 'x-demo.203-0-113-10.sslip.io' }],
    ['l + no address', params({ size: 'l' }), { autoHost: null }],
  ];

  for (const t of APP_TEMPLATES) {
    for (const [label, p, env] of variants) {
      it(`${t.id} (${label})`, () => {
        const { steps, primary } = compileTemplate(t, p, env);
        for (const s of steps) expect(BLUEPRINT_STEP_KINDS).toContain(s.kind);
        expect(steps.filter((s) => s.kind === 'stack.deploy')).toHaveLength(1);
        const deploy = deployOf(steps);

        // Persisted compose: credential- and token-free, deployable by the real pipeline.
        const src = deploy.payload.composeSource;
        expect(src).not.toContain('__SWARMY_');
        expect(src).not.toContain('${{');
        expect(src).not.toContain('[[opt.');
        const doc = parseYaml(src) as Record<string, unknown>;
        const plan = composeToStack(doc, p.name);
        expect(plan.services.map((s) => s.short)).toEqual(deploy.payload.services);
        const blocking = plan.warnings.filter((w) => w.level === 'warn');
        expect(blocking).toEqual([]);
        for (const model of composeToModels(doc).models) {
          expect(validateModel(model).filter((w) => w.level === 'warn')).toEqual([]);
        }

        // Wires target real services; every token they use is one the executor sets.
        const secretTokens = steps
          .filter((s) => s.kind === 'secret')
          .map((s) => (s.kind === 'secret' ? s.payload.token : undefined));
        const known = new Set([...FIXED_TOKENS, ...secretTokens]);
        const families = new Set(steps.map((s) => (s.kind === 'secret' ? s.payload.family : '')));
        for (const w of deploy.payload.wires) {
          expect(deploy.payload.services).toContain(w.service);
          if (w.type === 'secret') expect(families.has(w.family)).toBe(true);
          if (w.type === 'env') {
            for (const v of Object.values(w.env)) {
              for (const tok of v.match(/__SWARMY_[A-Z0-9_]+?__/g) ?? []) expect(known.has(tok)).toBe(true);
            }
          }
        }
        for (const n of deploy.payload.notes ?? []) {
          for (const tok of n.match(/__SWARMY_[A-Z0-9_]+?__/g) ?? []) expect(known.has(tok)).toBe(true);
          expect(n).not.toContain('${{');
        }

        // Display views never leak a token.
        for (const s of steps) {
          for (const v of Object.values(planStepView(s).detail)) expect(v).not.toContain('__SWARMY_');
        }

        // URL: a domain → route step; auto address → claim labels; neither → nothing.
        const route = steps.find((s) => s.kind === 'ingress.route');
        if (p.domain) {
          expect(route).toBeDefined();
          if (route?.kind === 'ingress.route') expect(route.payload.port).toBe(primary!.port);
        } else {
          expect(route).toBeUndefined();
          const labels = primary ? deploy.payload.postLabels[primary.name] : undefined;
          if (env.autoHost) expect(labels?.['swarmy.ingress.auto.host']).toBe(env.autoHost);
          else expect(labels).toBeUndefined();
        }

        // Managed data sized by the t-shirt size.
        const db = steps.find((s) => s.kind === 'db.provision');
        if (db?.kind === 'db.provision') {
          expect(db.payload.replicas).toBe({ s: 0, m: 1, l: 2 }[p.size]);
        }
      });
    }
  }
});

describe('binding resolution', () => {
  const umami = findAppTemplate('umami')!;
  const { steps } = compileTemplate(umami, params({ name: 'stats', domain: 'stats.example.com' }));
  const deploy = deployOf(steps);

  it('credentials go to post-deploy env wires, never into compose', () => {
    const env = deploy.payload.wires.find((w) => w.type === 'env');
    expect(env).toEqual({
      type: 'env',
      service: 'umami',
      env: {
        DATABASE_URL: TOKEN_DB_URL,
        APP_SECRET: secretToken(templateSecretFamily('stats', 'app-secret')),
      },
    });
  });

  it('joins the managed cluster network only for services that bind it', () => {
    const doc = parseYaml(deploy.payload.composeSource) as {
      services: Record<string, { networks: string[] }>;
      networks: Record<string, unknown>;
    };
    expect(doc.services.umami!.networks).toEqual(['default', 'stats_db-net']);
    expect(doc.networks).toEqual({ 'stats_db-net': { external: true } });
  });

  it('mounted secrets become secret wires (value never in env)', () => {
    const ghost = compileTemplate(findAppTemplate('ghost')!, params({ name: 'blog' }));
    const wires = deployOf(ghost.steps).payload.wires;
    expect(wires).toContainEqual({
      type: 'secret',
      service: 'mysql',
      family: 'blog-db-password',
      envName: 'MYSQL_PASSWORD_FILE',
    });
    // No domain and no auto address: app.url renders empty, with a note saying so.
    const src = parseYaml(deployOf(ghost.steps).payload.composeSource) as {
      services: { ghost: { environment: Record<string, string> } };
    };
    expect(src.services.ghost.environment.url).toBe('');
    expect(deployOf(ghost.steps).payload.notes?.[0]).toContain('app.url');
  });

  it('generated secrets carry their shape', () => {
    const s = steps.find((x) => x.kind === 'secret');
    if (s?.kind !== 'secret') throw new Error('no secret step');
    expect(s.payload).toMatchObject({ family: 'stats-app-secret', format: 'hex', length: 64 });
  });
});
