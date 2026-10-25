import { describe, expect, it } from 'bun:test';
import {
  DATA_IMAGES,
  POSTGRES_MAJORS,
  dataDeployRef,
  dataImage,
  dataImageFor,
  dataImageOfRef,
  isDataImage,
  offeredMajors,
} from './data-images';
import { manifestImages, buildPlatformManifest } from './platform-manifest';
import { DEFAULT_MANAGED_PG_IMAGE, DEFAULT_RESTIC_IMAGE, DEFAULT_WALG_IMAGE, managedPgImageForTag, managedPgImageOfLive } from './protocol';
import { MOVER_IMAGE } from './volume-move';
import { SYSTEM_IMAGES, systemImage } from './system-images';

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe('the BOM data section', () => {
  it('is part of the BOM, every entry with a role and the majors swarmy offers', () => {
    for (const img of DATA_IMAGES) {
      expect(SYSTEM_IMAGES).toContain(img);
      expect(img.role).toBeTruthy();
      expect(Array.isArray(img.majors)).toBe(true);
    }
    expect(offeredMajors('postgres')).toEqual([...POSTGRES_MAJORS]);
    expect(offeredMajors('valkey')).toEqual(['8']);
    for (const e of ['redis', 'meilisearch', 'typesense', 'qdrant'] as const) expect(offeredMajors(e)).toHaveLength(1);
  });

  it('keeps the tags swarmy has always run', () => {
    expect(DEFAULT_MANAGED_PG_IMAGE).toBe('pgvector/pgvector:pg17');
    expect(dataImageFor('postgres', '16')?.ref).toBe('pgvector/pgvector:pg16');
    expect(dataImageFor('valkey')?.ref).toBe('valkey/valkey:8');
    expect(dataImageFor('redis')?.ref).toBe('redis:7.4');
    expect(dataImageFor('meilisearch')?.ref).toBe('getmeili/meilisearch:v1.12');
    expect(dataImageFor('typesense')?.ref).toBe('typesense/typesense:27.1');
    expect(DEFAULT_RESTIC_IMAGE).toBe('restic/restic:0.16.4');
    expect(DEFAULT_WALG_IMAGE).toBe(systemImage('walg').ref);
    expect(MOVER_IMAGE).toBe('alpine:3.20');
  });

  it('a user-chosen Postgres version gets the BOM ref for it; an unlisted tag passes through', () => {
    expect(managedPgImageForTag('15')).toBe(dataImage('postgres15').ref);
    expect(managedPgImageForTag('pg14')).toBe(dataImage('postgres14').ref);
    expect(managedPgImageForTag('pg17-bookworm')).toBe('pgvector/pgvector:pg17-bookworm');
    expect(dataImageFor('postgres', '13')).toBeUndefined();
  });

  it('maps every live form of a data image back to its entry', () => {
    const m = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', digests: { postgres16: D('a') } });
    const images = manifestImages(m);
    const forms = [
      'pgvector/pgvector:pg16',
      `pgvector/pgvector:pg16@${D('a')}`,
      `docker.io/pgvector/pgvector:pg16@${D('a')}`,
      `localhost:5000/swarmy-system/docker.io/pgvector/pgvector:pg16@${D('a')}`,
      `docker.io/pgvector/pgvector@${D('a')}`,
    ];
    for (const f of forms) expect(dataImageOfRef(f, images)?.key).toBe('postgres16');
    expect(dataImageOfRef('mirror.local/pg:16')).toBeUndefined();
    expect(dataImageOfRef('pgvector/pgvector:pg17-bookworm')).toBeUndefined();
    expect(managedPgImageOfLive(`localhost:5000/swarmy-system/docker.io/pgvector/pgvector:pg16@${D('a')}`)).toBe('pgvector/pgvector:pg16');
    expect(managedPgImageOfLive('mirror.local/pg:16@sha256:abc')).toBe('mirror.local/pg:16');
  });

  it('a release digest fills an upstream entry and keeps its role; deploys keep the tag', () => {
    const m = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'c', tag: '1.3.0', digests: { redis: D('b') } });
    expect(m.components.redis).toEqual({ ref: 'redis:7.4', image: 'docker.io/library/redis', tag: '7.4', digest: D('b') });
    const redis = manifestImages(m).find((i) => i.key === 'redis');
    expect(isDataImage(redis)).toBe(true);
    expect(redis?.digest).toBe(D('b'));
    expect(dataDeployRef(`localhost:5000/swarmy-system/docker.io/library/redis@${D('b')}`, redis!)).toBe(
      `localhost:5000/swarmy-system/docker.io/library/redis:7.4@${D('b')}`,
    );
    expect(dataDeployRef(`redis:7.4@${D('b')}`, redis!)).toBe(`redis:7.4@${D('b')}`);
  });
});
