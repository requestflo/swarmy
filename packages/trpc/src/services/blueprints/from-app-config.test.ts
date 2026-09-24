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
  type PlanEnv,
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
    expect(TEMPLATE_ENTRIES.length).toBeGreaterThanOrEqual(50);
    const ids = ALL_BLUEPRINTS.map((e) => e.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BLUEPRINT_CATALOG) expect(findAppTemplate(b.meta.id)).toBeUndefined();
    expect(findBlueprint('nope')).toBeUndefined();
  });
});

describe('every template through the compose/model pipeline', () => {
  const variants: Array<[string, BlueprintParamsInput, PlanEnv]> = [
    ['m + domain', params({ domain: 'app.example.com' }), {}],
    ['s + auto address', params({ size: 's' }), { autoHost: 'x-demo.203-0-113-10.sslip.io' }],
    ['l + no address + pinned', params({ size: 'l' }), { autoHost: null, pinNode: 'swarm-node-1' }],
  ];

  for (const t of APP_TEMPLATES) {
    for (const [label, p, env] of variants) {
      it(`${t.id} (${label})`, () => {
        const pinned = env.pinNode;
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
        if (t.exposure === 'private') {
          expect(route).toBeUndefined();
          expect(deploy.payload.postLabels[primary!.name]).toEqual({ 'swarmy.ingress.auto': 'false' });
        } else if (p.domain) {
          expect(route).toBeDefined();
          if (route?.kind === 'ingress.route') expect(route.payload.port).toBe(primary!.port);
        } else {
          expect(route).toBeUndefined();
          const labels = primary ? deploy.payload.postLabels[primary.name] : undefined;
          if (env.autoHost) expect(labels?.['swarmy.ingress.auto.host']).toBe(env.autoHost);
          else expect(labels).toBeUndefined();
        }

        // Volume-backed services pin to one node when a pin is known.
        const svcs = (doc.services ?? {}) as Record<string, { volumes?: string[]; deploy?: { placement?: { constraints?: string[] } } }>;
        for (const svc of Object.values(svcs)) {
          const c = svc.deploy?.placement?.constraints;
          if (svc.volumes?.length && pinned) expect(c).toEqual([`node.id==${pinned}`]);
          else expect(c).toBeUndefined();
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
      env: { DATABASE_URL: TOKEN_DB_URL },
    });
  });

  it('a generated secret bound as a whole env value is env-delivered from its Docker secret', () => {
    // APP_SECRET: ${{ secrets.app-secret }} → the shim exports it; the value is
    // never substituted into env (no token in any env wire, none in compose).
    expect(deploy.payload.wires).toContainEqual({
      type: 'secret',
      service: 'umami',
      family: templateSecretFamily('stats', 'app-secret'),
      envName: 'APP_SECRET',
      delivery: 'env',
    });
    const token = secretToken(templateSecretFamily('stats', 'app-secret'));
    expect(JSON.stringify(deploy.payload.wires.filter((w) => w.type === 'env'))).not.toContain(token);
    expect(deploy.payload.composeSource).not.toContain('APP_SECRET');
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

describe('templates that send mail: the email wire', () => {
  it('Ghost binds its mail__* settings through the email service, never through compose', () => {
    const { steps } = compileTemplate(findAppTemplate('ghost')!, params({ name: 'blog' }));
    const deploy = deployOf(steps);
    const email = deploy.payload.wires.filter((w) => w.type === 'email');
    expect(email).toHaveLength(1);
    expect(email[0]).toMatchObject({ type: 'email', service: 'ghost', from: null });
    const env = (email[0] as Extract<(typeof email)[number], { type: 'email' }>).env;
    expect(env).toMatchObject({ mail__options__host: 'host', mail__options__auth__pass: 'password', mail__from: 'from', SMTP_PASS: 'password' });
    expect(deploy.payload.composeSource).not.toContain('mail__options__auth__pass');
    expect(deploy.payload.composeSource).not.toContain('email.');
    // Plain settings stay in compose.
    expect(deploy.payload.composeSource).toContain('mail__transport');
  });

  it('Vaultwarden and Plausible are wired too', () => {
    for (const id of ['vaultwarden', 'plausible']) {
      const deploy = deployOf(compileTemplate(findAppTemplate(id)!, params({ name: id })).steps);
      expect(deploy.payload.wires.some((w) => w.type === 'email')).toBe(true);
    }
  });
});
