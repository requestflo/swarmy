import { describe, expect, it } from 'bun:test';
import { composeToAppConfig } from './from-compose';
import { parseAppConfig } from './parse';

const COMPOSE = `
services:
  web:
    build: ./app
    ports: ["8080:3000"]
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
      REDIS_URL: redis://cache:6379
      NODE_ENV: production
    depends_on: [db, cache]
    volumes:
      - uploads:/app/uploads
      - ./local:/app/local
  worker:
    image: ghcr.io/acme/worker:1.2
    command: ["node", "worker.js"]
    deploy: { replicas: 2 }
    environment:
      - QUEUE_URL=redis://cache:6379/1
  db:
    image: postgres:16
  cache:
    image: redis:7-alpine
volumes:
  uploads: {}
`;

describe('composeToAppConfig', () => {
  const r = composeToAppConfig(COMPOSE, { app: 'Shop' });

  it('produces a swarmy.yaml that parses clean', () => {
    expect(r.yaml).not.toBeNull();
    const parsed = parseAppConfig(r.yaml!);
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(parsed.config?.app).toBe('shop');
  });

  it('turns data services into managed resources and binds env to them', () => {
    const cfg = parseAppConfig(r.yaml!).config!;
    expect(cfg.resources).toEqual({ db: 'postgres', cache: 'cache' });
    expect(cfg.services.web?.env?.DATABASE_URL).toBe('${{ db.url }}');
    expect(cfg.services.web?.env?.REDIS_URL).toBe('${{ cache.url }}');
    expect(cfg.services.web?.env?.NODE_ENV).toBe('production');
    expect(cfg.services.worker?.env?.QUEUE_URL).toBe('${{ cache.url }}');
  });

  it('keeps build/image, the container port, command, replicas and named volumes', () => {
    const cfg = parseAppConfig(r.yaml!).config!;
    expect(cfg.services.web?.build).toBe('app');
    expect(cfg.services.web?.port).toBe(3000);
    expect(cfg.services.web?.volumes).toEqual({ uploads: '/app/uploads' });
    expect(cfg.services.worker?.image).toBe('ghcr.io/acme/worker:1.2');
    expect(cfg.services.worker?.command).toEqual(['node', 'worker.js']);
    expect(cfg.services.worker?.replicas).toBe(2);
  });

  it('says what it dropped, each with why, and what changed shape', () => {
    const local = r.untranslated.find((g) => g.key === 'volumes: ./local:/app/local');
    expect(local).toMatchObject({ service: 'web' });
    expect(local?.reason).toContain('a folder on one server');
    expect(r.untranslated.find((g) => g.key === 'depends_on')).toMatchObject({ service: 'web', handled: true });
    expect(r.untranslated.find((g) => g.key === 'ports: 8080:3000')?.reason).toContain('address');
    // Every gap is also a plain-words note; changes are notes too.
    expect(r.notes.some((n) => n.startsWith("web: volumes: ./local:/app/local isn't carried over"))).toBe(true);
    expect(r.changes).toContain('web: DATABASE_URL now binds to ${{ db.url }} (swarmy fills in the real address and password).');
    expect(r.notes).toEqual(expect.arrayContaining(r.changes));
  });

  it('refuses junk', () => {
    expect(composeToAppConfig('services: [').yaml).toBeNull();
    expect(composeToAppConfig('version: "3"').yaml).toBeNull();
    expect(composeToAppConfig('services:\n  db:\n    image: postgres:16\n').yaml).toBeNull();
  });
});
