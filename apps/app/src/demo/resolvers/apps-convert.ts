import type { DomainResolvers } from '../types';

/**
 * `apps.convertToConfig` in demo mode: data's and platform's newest release
 * compose (releases.ts `dataCompose('2.4.0', 3)`, `platformCompose('0.42.1',
 * true)`) as Convert to swarmy.yaml writes it. Literal, so the converter
 * stays out of the main bundle; apps-convert.test.ts runs the real
 * `composeToAppConfig` over the same compose and keeps these identical.
 */
interface Gap {
  service: string;
  key: string;
  reason: string;
  handled?: true;
}
interface Fixture {
  yaml: string;
  changes: string[];
  untranslated: Gap[];
}

const HEAD = '# Converted from docker-compose by swarmy — review before you commit it.\nversion: 1\n';
const managed = (svc: string, image: string, kind: string): string => `${svc} (${image}) becomes a managed ${kind} resource "${svc}" — swarmy runs, backs up and wires it.`;
const bound = (key: string, to: string): string => `worker: ${key} now binds to \${{ ${to}.url }} (swarmy fills in the real address and password).`;
const opened = (svc: string, port: number): Gap => ({
  service: svc,
  key: `ports: ${port}:${port}`,
  reason: `port ${port} isn't opened on every server any more: the app's own services still reach it, and for the web, domains: gives it an address`,
});

export const DEMO_CONVERSIONS: Record<string, Fixture> = {
  data: {
    yaml: `${HEAD}app: data
services:
  nats:
    image: nats:2.10-alpine
    command:
      - -js
      - -sd
      - /data
    port: 4222
    replicas: 3
    volumes:
      nats: /data
  worker:
    image: ghcr.io/northwind/worker:2.4.0
    env:
      DATABASE_URL: \${{ postgres.url }}
      REDIS_URL: \${{ redis.url }}
      NATS_URL: nats://nats:4222
      MAILER_API_KEY: \${{ secrets.mailer-api-key }}
resources:
  postgres: postgres
  redis: cache
`,
    changes: [managed('postgres', 'postgres:16-alpine', 'postgres'), managed('redis', 'redis:7-alpine', 'cache'), bound('DATABASE_URL', 'postgres'), bound('REDIS_URL', 'redis')],
    untranslated: [
      {
        service: 'postgres',
        key: 'volumes: pgdata:/var/lib/postgresql/data',
        reason: 'the data in it doesn\'t move: the managed postgres "postgres" starts empty, so restore a dump into it after the first deploy',
      },
      { service: 'postgres', key: 'environment', reason: 'swarmy sets up the managed postgres with its own credentials and hands them to your services through bindings' },
      opened('nats', 4222),
      {
        service: 'worker',
        key: 'environment.MAILER_API_KEY',
        reason: 'its value looks like a credential, so it stays out of a file headed for git: create the swarmy secret mailer-api-key with it (the file reads ${{ secrets.mailer-api-key }})',
      },
      {
        service: 'worker',
        key: 'volumes: ./exports:/app/exports',
        reason: 'a folder on one server, and swarmy uses named volumes so the app can move between servers: copy what it needs into the image or a volume',
      },
      { service: 'worker', key: 'privileged', reason: "swarm services can't run privileged, and swarmy.yaml has no way to ask for it" },
      { service: 'worker', key: 'depends_on', reason: 'swarmy wires services and resources together itself', handled: true },
      { service: 'worker', key: 'restart', reason: 'swarmy restarts a service that stops', handled: true },
    ],
  },
  platform: {
    yaml: `${HEAD}app: platform
services:
  gateway:
    image: ghcr.io/northwind/platform-gateway:0.42.1
    port: 8080
  auth:
    image: ghcr.io/northwind/platform-auth:0.42.1
resources:
  cache: cache
`,
    changes: [managed('cache', 'valkey/valkey:8', 'cache')],
    untranslated: [opened('gateway', 8080)],
  },
};

export const appsConvert: DomainResolvers = {
  handlers: {
    'apps.convertToConfig': (i) => {
      const { stack } = i as { stack: string };
      const f = DEMO_CONVERSIONS[stack];
      const base = { stack, path: 'swarmy.yaml' as const, issues: [] };
      if (!f) return { ...base, yaml: null, valid: false, changes: [], untranslated: [], reason: `swarmy didn't deploy ${stack} from compose, so it has no compose to convert.` };
      return { ...base, ...f, valid: true, reason: null };
    },
  },
};
