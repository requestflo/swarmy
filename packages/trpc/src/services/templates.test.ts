import { describe, expect, it } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import { MANAGED_PG_ROOT, pgBootScript } from '@swarmy/core';
import { composeEscape, renderTemplate } from './templates';

/** HA templates run official upstream images only (self-reliance B5). */
describe('HA templates — official images + swarmy boot layer', () => {
  const regions = ['eu', 'us', 'ap'];
  const pg = renderTemplate('postgres-ha', { name: 'orders-db', regions })!;
  const kv = renderTemplate('redis-ha', { name: 'sess', regions })!;

  it('no Bitnami image or env anywhere', () => {
    for (const t of [pg, kv]) {
      expect(t.composeSource).not.toMatch(/image: .*bitnami/i);
      for (const svc of t.services) {
        expect(svc.image).not.toMatch(/bitnami/i);
        expect(Object.keys(svc.env ?? {}).join(' ')).not.toMatch(/POSTGRESQL_|REPMGR_|REDIS_/);
      }
    }
  });

  it('postgres-ha: member 0 writes, the rest stream from it, all on the data-root volume', () => {
    expect(pg.services.map((s) => s.image)).toEqual(Array(3).fill('pgvector/pgvector:pg17'));
    expect(pg.services[0]!.env?.SWARMY_PG_ROLE).toBe('primary');
    expect(pg.services[1]!.env).toMatchObject({ SWARMY_PG_ROLE: 'replica', SWARMY_PG_PRIMARY_HOST: 'orders-db-pg-0' });
    expect(pg.services[1]!.command?.[2]).toBe(pgBootScript());
    expect(pg.services[2]!.mounts).toEqual([{ type: 'volume', source: 'orders-db-pg-2-data', target: MANAGED_PG_ROOT }]);
    expect(pg.durabilityNote).toContain('MANUAL');
  });

  it('compose: the boot script is the ENTRYPOINT with every shell `$` escaped for docker stack deploy', () => {
    const doc = parseYaml(pg.composeSource) as {
      services: Record<string, { entrypoint: string[]; volumes: string[] }>;
    };
    const m = doc.services['orders-db-pg-1']!;
    expect(m.entrypoint[2]).toBe(composeEscape(pgBootScript()));
    expect(m.entrypoint[2]!.replace(/\$\$/g, '$')).toBe(pgBootScript());
    expect(m.volumes).toEqual([`orders-db-pg-1-data:${MANAGED_PG_ROOT}`]);
  });

  it('redis-ha: valkey server/replica/sentinel with the password from env, sentinels follow live peers', () => {
    expect(new Set(kv.services.map((s) => s.image))).toEqual(new Set(['valkey/valkey:8']));
    const [master, replica, sentinel] = kv.services;
    expect(master!.command?.[2]).toContain('--requirepass "$VALKEY_PASSWORD"');
    expect(replica!.command?.[2]).toContain('--replicaof sess-redis-master 6379');
    expect(sentinel!.command?.[2]).toContain('sentinel monitor main $MASTER $MPORT 2');
    expect(sentinel!.command?.[2]).toContain('for h in sess-redis-sentinel-0 sess-redis-sentinel-1 sess-redis-sentinel-2');
    expect(parseYaml(kv.composeSource)).toBeTruthy();
  });
});
