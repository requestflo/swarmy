import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { loadTemplate } from '../render';
import { convertCoolifyTemplate, envRefs, mapCategory, parseMagic } from './coolify';

const UMAMI = `# documentation: https://umami.is
# slogan: Umami is a simple web analytics platform. It respects privacy.
# category: analytics
# logo: svgs/umami.svg
# port: 3000

services:
  umami:
    image: ghcr.io/umami-software/umami:3.0.3
    environment:
      - SERVICE_URL_UMAMI_3000
      - DATABASE_URL=postgres://$SERVICE_USER_POSTGRES:$SERVICE_PASSWORD_POSTGRES@postgresql:5432/$POSTGRES_DB
      - APP_SECRET=$SERVICE_PASSWORD_64_UMAMI
      - BASE=\${SERVICE_URL_UMAMI}
      - SMTP_HOST=\${SMTP_HOST}
      - MODE=\${MODE:-production}
      - REDIS_URL=redis://default:\${SERVICE_PASSWORD_REDIS}@redis:6379
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://127.0.0.1:3000/api/heartbeat || exit 1"]
      interval: 5s
      timeout: 20s
      retries: 10
  postgresql:
    image: postgres:16-alpine
    volumes:
      - postgresql-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=$SERVICE_USER_POSTGRES
      - POSTGRES_PASSWORD=$SERVICE_PASSWORD_POSTGRES
      - POSTGRES_DB=\${POSTGRES_DB:-umami}
  redis:
    image: redis:7-alpine
    command: redis-server --requirepass \${SERVICE_PASSWORD_REDIS}
`;

describe('coolify importer', () => {
  const r = convertCoolifyTemplate('umami', UMAMI);
  const t = r.template!;
  const yaml = parseYaml(t.yaml) as {
    services: Record<string, { env: Record<string, string>; port?: number; healthcheck?: unknown }>;
    resources: Record<string, { type: string; database?: string; memory?: string }>;
  };

  it('converts cleanly and parses as swarmy.yaml', () => {
    expect(r.status).toBe('clean');
    expect(loadTemplate(t, { stack: 'demo' }).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('swaps the bundled postgres + redis for managed resources', () => {
    expect(Object.keys(yaml.services)).toEqual(['umami']);
    expect(yaml.resources).toEqual({ db: { type: 'postgres', database: 'umami' }, cache: { type: 'cache', memory: '64mb' } });
    expect(yaml.services.umami!.env.DATABASE_URL).toBe(
      'postgres://${{ db.user }}:${{ db.password }}@${{ db.host }}:5432/${{ db.database }}',
    );
    expect(yaml.services.umami!.env.REDIS_URL).toBe('redis://default:${{ cache.password }}@${{ cache.host }}:6379');
  });

  it('maps SERVICE_* magic: URL → app.url + primary port, passwords → generated secrets', () => {
    expect(yaml.services.umami!.port).toBe(3000);
    expect(yaml.services.umami!.env.BASE).toBe('${{ app.url }}');
    expect(yaml.services.umami!.env.APP_SECRET).toBe('${{ secrets.umami-password }}');
    expect(t.generate).toEqual({ 'umami-password': { format: 'alnum', length: 64 } });
  });

  it('resolves defaults, drops empty optionals, keeps attribution', () => {
    expect(yaml.services.umami!.env.MODE).toBe('production');
    expect(yaml.services.umami!.env.SMTP_HOST).toBeUndefined();
    expect(t.source).toEqual({ kind: 'coolify', path: 'templates/compose/umami.yaml' });
    expect(t.tagline).toBe('Umami is a simple web analytics platform');
    expect(t.category).toBe('analytics');
  });

  it('rejects what swarmy cannot run', () => {
    const sock = `services:\n  a:\n    image: x:1\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`;
    expect(convertCoolifyTemplate('a', sock).status).toBe('rejected');
    expect(convertCoolifyTemplate('b', `services:\n  a:\n    build: .\n`).status).toBe('rejected');
    expect(convertCoolifyTemplate('c', `# ignore: true\nservices:\n  a:\n    image: x:1\n`).status).toBe('rejected');
    const cfg = `# port: 80\nservices:\n  a:\n    image: x:1\n    volumes:\n      - type: bind\n        source: ./c.xml\n        target: /c.xml\n        content: "<x/>"\n`;
    expect(convertCoolifyTemplate('d', cfg).reasons[0]).toContain('config file');
  });

  it('flags unpinned images and user input for review', () => {
    const src = `# port: 80\nservices:\n  web:\n    image: nginx:latest\n    environment:\n      - KEY=prefix-\${API_KEY}\n`;
    const res = convertCoolifyTemplate('e', src);
    expect(res.status).toBe('review');
    expect(res.reasons.join(' ')).toContain('not pinned');
    expect(res.template?.options?.[0]?.key).toBe('API_KEY');
  });
});

describe('helpers', () => {
  it('parses magic names', () => {
    expect(parseMagic('SERVICE_URL_APP_8080')).toEqual({ kind: 'url', service: 'app', port: 8080 });
    expect(parseMagic('SERVICE_FQDN_WEB')).toEqual({ kind: 'fqdn', service: 'web' });
    expect(parseMagic('SERVICE_HEX_64_KEY')).toMatchObject({ kind: 'gen', gen: { format: 'hex', length: 64 } });
    expect(parseMagic('SERVICE_SUPABASEANON_KEY')).toMatchObject({ kind: 'unsupported' });
    expect(parseMagic('OTHER')).toBeNull();
  });
  it('finds env refs with defaults and skips $$', () => {
    expect(envRefs('a $X ${Y:-d} $$Z ${W}')).toEqual([{ name: 'X' }, { name: 'Y', default: 'd' }, { name: 'W' }]);
  });
  it('maps categories', () => {
    expect(mapCategory('git')).toBe('devtools');
    expect(mapCategory('database,observability')).toBe('data');
    expect(mapCategory('vpn')).toBe('app');
  });
});
