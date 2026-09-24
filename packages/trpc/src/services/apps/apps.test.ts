import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import {
  emptyLive,
  parseAppConfig,
  planApp,
  toDesired,
  type DesiredApp,
  type DesiredRoute,
  type DesiredJob,
} from '@swarmy/app-config';
import { applyPlan, type AppOps } from './apply';
import { addressingMap, appBucketName, attachmentKey, compileServices, type Attachment } from './compile';
import {
  APP_SIG_LABEL,
  APP_STACK_LABEL,
  emptyLedger,
  readLiveApp,
  type AppLedger,
  type LiveServiceLike,
} from './live';

const desired = (text: string, opts?: Parameters<typeof toDesired>[1]): DesiredApp => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return toDesired(r.config, opts);
};

const APP = `version: 1
app: shop
services:
  web:
    build: .
    port: 3000
    release: npm run migrate
    sleep_after: 15m
    domains: [shop.example.com]
    env:
      DATABASE_URL: \${{ db.url }}
      DATABASE_RO_URL: \${{ db.ro_url }}
      DB_HOST: \${{ db.host }}
      REDIS_URL: \${{ cache.url }}
      S3_BUCKET: \${{ files.bucket }}
      S3_ACCESS_KEY_ID: \${{ files.access_key_id }}
      PUBLIC_URL: \${{ app.url }}
      API: \${{ services.api.url }}
    secrets: [stripe-key]
  api:
    image: ghcr.io/shop/api:1.2.0
    port: 8080
resources:
  db: postgres
  cache: cache
  files: bucket
jobs:
  nightly: { schedule: "0 3 * * *", run: npm run nightly }
`;

describe('compileServices', () => {
  it('renders addressing into compose, credentials into attachments', () => {
    const d = desired(APP);
    const out = compileServices(
      d,
      { web: 'localhost:5000/shop@sha256:aa', api: 'ghcr.io/shop/api:1.2.0' },
      { commit: 'c'.repeat(40) },
    );
    expect(out.issues).toEqual([]);
    const doc = parseYaml(out.composeSource) as {
      services: Record<string, Record<string, unknown>>;
    };
    const web = doc.services.web as {
      environment: Record<string, string>;
      deploy: { labels: Record<string, string>; replicas: number };
      image: string;
    };
    expect(web.image).toBe('localhost:5000/shop@sha256:aa');
    expect(web.environment).toEqual({
      DB_HOST: 'shop_db-primary',
      S3_BUCKET: 'shop-files',
      PUBLIC_URL: 'https://shop.example.com',
      API: 'http://api:8080',
    });
    // No credential ever reaches the compose source.
    expect(out.composeSource).not.toMatch(/DATABASE_URL|REDIS_URL|S3_ACCESS_KEY_ID/);
    expect(web.deploy.labels).toMatchObject({
      [APP_STACK_LABEL]: 'shop',
      'swarmy.app.service': 'web',
      'swarmy.app.environment': 'production',
      'swarmy.scaleToZero.enabled': 'true',
      'swarmy.scaleToZero.idleSeconds': '900',
      'swarmy.deploy.safety': '{"windowSec":120,"autoRollback":true}',
    });
    expect(out.attachments).toEqual<Attachment[]>([
      { kind: 'db', service: 'web', cluster: 'db', envVar: 'DATABASE_URL' },
      { kind: 'cache', service: 'web', cluster: 'cache', envVar: 'REDIS_URL' },
      { kind: 'bucket', service: 'web', resource: 'files' },
      { kind: 'secret', service: 'web', family: 'stripe-key' },
    ]);
  });

  it('refuses embedded credentials and mis-named fixed vars with located errors; env-delivers secret values', () => {
    const d = desired(
      APP.replace('DB_HOST: ${{ db.host }}', 'DSN: "postgres://${{ db.url }}?x=1"')
        .replace('DATABASE_RO_URL: ${{ db.ro_url }}', 'DB_RO: ${{ db.ro_url }}')
        .replace('S3_ACCESS_KEY_ID:', 'MY_KEY:')
        .replace('PUBLIC_URL: ${{ app.url }}', 'STRIPE: ${{ secrets.stripe-key }}'),
    );
    const out = compileServices(d, { web: 'w@sha256:1', api: 'a:1' });
    expect(
      out.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.code} @ ${i.path.join('.')}`),
    ).toEqual([
      'apply/ro-url-name @ services.web.env.DB_RO',
      'apply/credential-embedded @ services.web.env.DSN',
      'apply/s3-key-name @ services.web.env.MY_KEY',
    ]);
    // A whole-value secret binding is env-delivered by the shim, not refused.
    expect(out.attachments).toContainEqual({
      kind: 'secret',
      service: 'web',
      family: 'stripe-key',
      envName: 'STRIPE',
    });
    expect(out.composeSource).not.toContain('STRIPE');
  });

  it('first deploy of a service with a release starts at 0 replicas', () => {
    const out = compileServices(
      desired(APP),
      { web: 'w@sha256:1', api: 'a:1' },
      { replicasOverride: { web: 0 } },
    );
    const doc = parseYaml(out.composeSource) as {
      services: { web: { deploy: { replicas: number } } };
    };
    expect(doc.services.web.deploy.replicas).toBe(0);
  });

  it('addressing is environment-aware', () => {
    const m = addressingMap(
      desired(
        APP.replace('app: shop', 'app: shop') + 'environments:\n  staging: { branch: staging }\n',
        { environment: 'staging' },
      ),
    );
    expect(m['db.host']).toBe('shop-staging_db-primary');
    expect(m['app.environment']).toBe('staging');
    expect(m['app.url']).toBeUndefined(); // staging has no domain unless it declares one
    expect(appBucketName('shop-staging', 'files')).toBe('shop-staging-files');
  });
});

describe('ledger: removed postgres keeps its volumes', () => {
  it('records the kept volumes on resource.delete', async () => {
    const { ledgerAfter } = await import('./live');
    const d = desired(APP);
    const next = ledgerAfter(
      { ...emptyLedger(), resources: { db: d.resources.find((r) => r.name === 'db')! } },
      d,
      {
        id: 'resource.delete:db',
        phase: 6,
        gate: 'confirm',
        reason: '',
        kind: 'resource.delete',
        name: 'db',
        resourceType: 'postgres',
      },
    );
    expect(next.resources.db).toBeUndefined();
    expect(next.kept?.db?.length).toBe(3);
    expect(next.kept?.db?.every((v) => v.startsWith('shop_db'))).toBe(true);
  });
});

describe('readLiveApp', () => {
  it('only app-stamped services count; resources exist when their service does; adoption has no sig', () => {
    const d = desired(APP);
    const ledger: AppLedger = {
      ...emptyLedger(),
      services: { web: { sig: 'old', image: 'w@1', volumes: [] } },
      resources: {
        cache: d.resources.find((r) => r.name === 'cache')!,
        files: d.resources.find((r) => r.name === 'files')!,
      },
    };
    const live = readLiveApp({
      stack: 'shop',
      services: [
        {
          name: 'shop_web',
          image: 'w@2',
          labels: {
            [APP_STACK_LABEL]: 'shop',
            'swarmy.app.service': 'web',
            [APP_SIG_LABEL]: 'live-sig',
          },
        },
        { name: 'shop_legacy', image: 'x', labels: {} }, // hand-made: never touched
        { name: 'shop_db-primary', image: 'pg', labels: {} }, // exists but not in the ledger → adoption
      ],
      ledger,
      jobNames: new Set(),
      desiredResources: d.resources,
    });
    expect(live.services).toEqual([{ name: 'web', image: 'w@2', sig: 'live-sig', volumes: [] }]);
    // cache: in ledger but its service is gone → missing; files: bucket (no service) → ledger; db: adoption.
    expect(live.resources.map((r) => `${r.name}:${r.sig ? 'sig' : 'nosig'}`)).toEqual([
      'files:sig',
      'db:nosig',
    ]);
  });
});

/** A recording fake of the ops port. */
function fakeOps(over: Partial<AppOps> = {}) {
  const calls: string[] = [];
  const ops: AppOps = {
    createResource: async (r) => (
      calls.push(`create ${r.type}:${r.name}`),
      r.type === 'bucket' ? { bucketId: 'b-1' } : {}
    ),
    updateResource: async (r) => void calls.push(`update ${r.name}`),
    deleteResource: async (n) => void calls.push(`delete ${n}`),
    build: async (a) => (
      calls.push(`build ${a.context}`),
      { image: 'localhost:5000/shop@sha256:new' }
    ),
    deploy: async (src) => {
      const doc = parseYaml(src) as { services: Record<string, { deploy: { replicas: number } }> };
      calls.push(
        `deploy ${Object.entries(doc.services)
          .map(([n, s]) => `${n}×${s.deploy.replicas}`)
          .join(',')}`,
      );
    },
    attach: async (a) =>
      void calls.push(
        `attach ${a.kind}:${'envVar' in a ? a.envVar : 'family' in a ? a.family : a.kind}`,
      ),
    runRelease: async (s, img, cmd) => void calls.push(`release ${s} ${img} ${cmd.join(' ')}`),
    setRoutes: async (s, r: DesiredRoute[]) =>
      void calls.push(`routes ${s} ${r.map((x) => x.host).join(',')}`),
    upsertJob: async (j: DesiredJob) => (calls.push(`job ${j.name}`), { jobId: `job-${j.name}` }),
    removeJob: async (id) => void calls.push(`rmjob ${id}`),
    link: async (p) => void calls.push(`link ${p}`),
    unlink: async (p) => void calls.push(`unlink ${p}`),
    removeService: async (n) => void calls.push(`rm ${n}`),
    liveImage: () => undefined,
    ...over,
  };
  return { ops, calls };
}

describe('applyPlan', () => {
  it('first deploy: resources → build → deploy at 0 → attach → release → scale up → routes → jobs', async () => {
    const d = desired(APP);
    const plan = planApp(d, emptyLive('shop'));
    const { ops, calls } = fakeOps();
    const res = await applyPlan({ plan, desired: d, ledger: emptyLedger(), ops });
    expect(res.status).toBe('applied');
    expect(calls).toEqual([
      'create postgres:db',
      'create cache:cache',
      'create bucket:files',
      'build .',
      'deploy api×1,web×0',
      'attach db:DATABASE_URL',
      'attach cache:REDIS_URL',
      'attach bucket:bucket',
      'attach secret:stripe-key',
      'release web localhost:5000/shop@sha256:new sh -c npm run migrate',
      'deploy api×1,web×1',
      'routes web shop.example.com',
      'job nightly',
    ]);
    expect(res.ledger.resources.files?.bucketId).toBe('b-1');
    expect(res.ledger.jobs.nightly).toEqual({ sig: d.jobs[0]!.sig, jobId: 'job-nightly' });
    expect(res.ledger.attached.web).toEqual([
      'db:db:DATABASE_URL',
      'cache:cache:REDIS_URL',
      'bucket:files',
      'secret:stripe-key',
    ]);

    // Re-plan against the resulting ledger + live: nothing left to do (for the same commit's paths).
    const live = readLiveApp({
      stack: 'shop',
      services: d.services
        .map(
          (s): LiveServiceLike => ({
            name: s.serviceName,
            image: res.ledger.services[s.name]!.image,
            labels: {
              [APP_STACK_LABEL]: 'shop',
              'swarmy.app.service': s.name,
              [APP_SIG_LABEL]: s.sig,
              ...(s.source.kind === 'build' ? { 'swarmy.app.build': s.source.key } : {}),
            },
          }),
        )
        .concat([
          { name: 'shop_db-primary', image: 'pg', labels: {} },
          { name: 'shop_cache-cache', image: 'valkey', labels: {} },
        ]),
      ledger: res.ledger,
      jobNames: new Set(['nightly']),
      desiredResources: d.resources,
    });
    expect(planApp(d, live, { changedPaths: [] }).status).toBe('noop');
  });

  it('update with a release runs it in the NEW image before the rollout; attachments are not repeated', async () => {
    const d = desired(APP);
    const first = await applyPlan({
      plan: planApp(d, emptyLive('shop')),
      desired: d,
      ledger: emptyLedger(),
      ops: fakeOps().ops,
    });
    const live = readLiveApp({
      stack: 'shop',
      services: d.services
        .map(
          (s): LiveServiceLike => ({
            name: s.serviceName,
            image: 'old',
            labels: {
              [APP_STACK_LABEL]: 'shop',
              'swarmy.app.service': s.name,
              [APP_SIG_LABEL]: s.sig,
              ...(s.source.kind === 'build' ? { 'swarmy.app.build': s.source.key } : {}),
            },
          }),
        )
        .concat([
          { name: 'shop_db-primary', image: 'pg', labels: {} },
          { name: 'shop_cache-cache', image: 'valkey', labels: {} },
        ]),
      ledger: first.ledger,
      jobNames: new Set(['nightly']),
      desiredResources: d.resources,
    });
    const plan = planApp(d, live, { changedPaths: ['src/index.ts'] });
    const { ops, calls } = fakeOps({
      liveImage: (s) => (s === 'api' ? 'ghcr.io/shop/api:1.2.0' : 'old'),
    });
    const res = await applyPlan({ plan, desired: d, ledger: first.ledger, ops });
    expect(res.status).toBe('applied');
    expect(calls).toEqual([
      'build .',
      'release web localhost:5000/shop@sha256:new sh -c npm run migrate',
      'deploy api×1,web×1',
    ]);
  });

  it('holds confirm actions, runs them once confirmed, and a failure stops later phases', async () => {
    const before = desired(APP);
    const after = desired(
      APP.replace('  files: bucket\n', '').replace(
        /      S3_BUCKET.*\n      S3_ACCESS_KEY_ID.*\n/,
        '',
      ),
    );
    const ledger = (
      await applyPlan({
        plan: planApp(before, emptyLive('shop')),
        desired: before,
        ledger: emptyLedger(),
        ops: fakeOps().ops,
      })
    ).ledger;
    const live = readLiveApp({
      stack: 'shop',
      services: before.services
        .map(
          (s): LiveServiceLike => ({
            name: s.serviceName,
            image: 'i',
            labels: {
              [APP_STACK_LABEL]: 'shop',
              'swarmy.app.service': s.name,
              [APP_SIG_LABEL]: s.sig,
              'swarmy.app.build': s.source.kind === 'build' ? s.source.key : '',
            },
          }),
        )
        .concat([
          { name: 'shop_db-primary', image: 'pg', labels: {} },
          { name: 'shop_cache-cache', image: 'v', labels: {} },
        ]),
      ledger,
      jobNames: new Set(['nightly']),
      desiredResources: before.resources,
    });
    const plan = planApp(after, live, { changedPaths: ['swarmy.yaml'] });
    expect(plan.actions.map((a) => `${a.gate} ${a.id}`)).toEqual([
      'auto service.deploy:web',
      'confirm resource.delete:files',
    ]);

    const held = fakeOps({ liveImage: () => 'i' });
    const r1 = await applyPlan({ plan, desired: after, ledger, ops: held.ops });
    expect(r1.status).toBe('needs-confirmation');
    expect(held.calls).toEqual(['release web i sh -c npm run migrate', 'deploy api×1,web×1']); // release runs on every rollout
    expect(r1.outcomes['resource.delete:files']?.status).toBe('held');

    const conf = fakeOps({ liveImage: () => 'i' });
    const r2 = await applyPlan({
      plan,
      desired: after,
      ledger: r1.ledger,
      ops: conf.ops,
      confirmed: ['resource.delete:files'],
    });
    expect(r2.status).toBe('applied');
    expect(conf.calls).toContain('delete files');
    expect(r2.ledger.resources.files).toBeUndefined();
    expect(r2.ledger.kept ?? {}).toEqual({}); // a bucket delete keeps nothing

    const broken = fakeOps({
      build: async () => {
        throw new Error('exit 1');
      },
    });
    const r3 = await applyPlan({
      plan: planApp(before, emptyLive('shop')),
      desired: before,
      ledger: emptyLedger(),
      ops: broken.ops,
    });
    expect(r3.status).toBe('failed');
    expect(r3.error).toContain('exit 1');
    expect(
      broken.calls.some(
        (c) => c.startsWith('deploy') || c.startsWith('routes') || c.startsWith('job'),
      ),
    ).toBe(false);
    expect(r3.outcomes['service.deploy:web']?.status).toBe('skipped');
  });
});

describe('ai: binding → one ai attachment per bound service', () => {
  it('compiles the allowlist/budget into the attachment; its ledger key tracks changes', () => {
    const d = desired(`version: 1
app: shop
services:
  web:
    image: ghcr.io/acme/web:1
    port: 3000
  worker:
    image: ghcr.io/acme/worker:1
ai:
  models: [smart, embed]
  budget: 5/day
  services: [web]
`);
    const out = compileServices(d, { web: 'ghcr.io/acme/web:1', worker: 'ghcr.io/acme/worker:1' });
    const ai = out.attachments.filter((a): a is Extract<Attachment, { kind: 'ai' }> => a.kind === 'ai');
    expect(ai).toEqual([{ kind: 'ai', service: 'web', models: ['smart', 'embed'], dailyBudgetUsd: 5, rpm: null }]);
    // The key never lands in the compose; the base URLs arrive with the binding.
    expect(out.composeSource).not.toContain('OPENAI');
  });
});

describe('email: binding → one email attachment per bound service', () => {
  it('SMTP_* / EMAIL_API_* come from the attachment, never the compose; explicit ${{ email.* }} names too', () => {
    const d = desired(`version: 1
app: shop
services:
  web:
    image: ghcr.io/acme/web:1
    port: 3000
    env:
      MAIL_PASSWORD: \${{ email.password }}
  worker:
    image: ghcr.io/acme/worker:1
email:
  from: noreply@shop.example.com
  services: [worker]
`);
    const out = compileServices(d, { web: 'ghcr.io/acme/web:1', worker: 'ghcr.io/acme/worker:1' });
    expect(out.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const email = out.attachments.filter((a): a is Extract<Attachment, { kind: 'email' }> => a.kind === 'email');
    expect(email.map((a) => [a.service, a.from, Object.keys(a.env)])).toEqual([
      ['web', 'noreply@shop.example.com', ['MAIL_PASSWORD']],
      ['worker', 'noreply@shop.example.com', ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_FROM', 'EMAIL_API_URL', 'EMAIL_API_KEY']],
    ]);
    expect(out.composeSource).not.toContain('MAIL_PASSWORD');
    expect(out.composeSource).not.toContain('SMTP_');
    expect(attachmentKey(email[0]!)).toBe('email:noreply@shop.example.com:MAIL_PASSWORD=password');
  });
});
