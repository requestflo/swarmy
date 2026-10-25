import type { ServiceDetail } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { pushDemoAudit, renumberDemoAudit, type Actor } from './auditlog';
import { seedDemoRoute } from './ingress';

/**
 * storefront's other environment, live: `apps.list` already names staging
 * (branch staging → stack storefront-staging), so the demo swarm runs it —
 * one copy each, web and checkout on newer digests than production, api on
 * the same image. Plus the back-dated audit rows behind storefront's secrets
 * (the rotations and the reveal the Variables & secrets feed shows).
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ago: number): string => new Date(Date.now() - ago).toISOString();
const STACK = { id: 's-store-staging', name: 'storefront-staging', serviceCount: 3, status: 'running', updatedAt: iso(40 * 60_000) };
const digest = (seed: string): string => `sha256:${seed}${'0123456789abcdef'.repeat(4).slice(seed.length)}`;

function staging(id: string, name: string, image: string, env: Record<string, string>): ServiceDetail {
  return {
    id,
    name: `storefront-staging_${name}`,
    image,
    status: 'running',
    replicas: { desired: 1, running: 1 },
    ingressEnabled: name === 'web',
    nodeId: null,
    stackId: STACK.id,
    updatedAt: iso(40 * 60_000),
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      ...env,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://swarmy-otel-collector:4317',
      OTEL_SERVICE_NAME: `storefront-staging-${name}`,
    },
    ports: [],
    volumes: [],
    networks: [`${STACK.id}_net`],
    constraints: [],
    swarmServiceId: `svc-${id}`,
    createdAt: iso(20 * DAY),
  };
}

const AVA: Actor = { actorType: 'user', actorId: 'user-ava', actorLabel: 'Ava Chen' };
const MARCO: Actor = { actorType: 'user', actorId: 'user-marco', actorLabel: 'Marco Ruiz' };

export const appEnvironments: DomainResolvers = {
  seed: (store: DemoStore) => {
    // The just-installed world (?fresh=1) has no storefront, so no staging either.
    if (!store.stacks.some((s) => s.id === 's-store')) return;
    if (!store.stacks.some((s) => s.id === STACK.id)) {
      store.stacks.push(STACK);
      store.services.push(
        staging('svc-stg-web', 'web', `ghcr.io/northwind/web@${digest('d4e5f6a7')}`, {
          PUBLIC_URL: 'https://staging.shop.northwind.dev',
          API_URL: 'http://api:8080',
          SHOP_CURRENCY: 'GBP',
        }),
        staging('svc-stg-api', 'api', 'ghcr.io/northwind/api:2.4.0', { DATABASE_RO_URL: '${{ db.ro_url }}', SHOP_CURRENCY: 'GBP' }),
        staging('svc-stg-checkout', 'checkout', `ghcr.io/northwind/checkout@${digest('91ab20c3')}`, {
          DATABASE_RO_URL: '${{ db.ro_url }}',
          CHECKOUT_TIMEOUT_MS: '8000',
        }),
      );
      // Its own domain (environments.staging.services.web.domains): the lane shows it.
      seedDemoRoute(store, { host: 'staging.shop.northwind.dev', serviceId: 'svc-stg-web', serviceName: 'storefront-staging_web', stack: STACK.name, port: 3000, auto: false, issuingUntil: 0 });
    }
    const pilot: Actor = { actorType: 'user', actorId: store.user.id, actorLabel: store.user.name };
    pushDemoAudit(store, { actor: pilot, ts: iso(6 * DAY), action: 'secrets.rotate', targetType: 'secretFamily', targetId: 'DATABASE_URL', metadata: { version: 3, redeployed: ['api', 'checkout', 'worker'] } });
    pushDemoAudit(store, { actor: pilot, ts: iso(3 * DAY), action: 'secrets.appVar.set', targetType: 'service', targetId: 'svc-api', metadata: { service: 'api', key: 'DATABASE_PASSWORD', delivery: 'env', rotated: true, version: 2 } });
    pushDemoAudit(store, { actor: AVA, ts: iso(2 * DAY), action: 'secrets.rotate', targetType: 'secretFamily', targetId: 'STRIPE_SECRET_KEY', metadata: { version: 2, redeployed: ['api'] } });
    pushDemoAudit(store, { actor: MARCO, ts: iso(3 * HOUR), action: 'secrets.reveal', targetType: 'service', targetId: 'svc-api', metadata: { service: 'api', key: 'DATABASE_PASSWORD', version: 2, ok: true } });
    renumberDemoAudit(store);
  },
};
