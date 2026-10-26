/**
 * The BOM's data-images section: every image swarmy itself runs for managed
 * data — the engines behind managed Postgres, caches, search and vector
 * indexes, and the one-shot helpers its backups, restores, dumps and volume
 * moves run. It is part of `SYSTEM_IMAGES` (system-images.ts), so each entry
 * is a platform.json component, pinned and mirrored by the hub dispatch
 * decorator like any system image, and carried by the offline bundle
 * (`planBundle`; opt out with `--without data-images`).
 *
 * What sets the section apart: a platform upgrade never rolls these images. A
 * database keeps the image it was created on until something on that cluster
 * changes it (a re-provision, a restore as a copy), so the drift view never
 * lists them (platform-drift.ts). Garage stays in the platform section: the
 * platform run moves object storage itself (`garage-v1-to-v2`).
 *
 * Each entry has a role and the engine majors swarmy offers on it: an engine
 * runs one major, a helper serves every major of its engine (none = any
 * engine). The engines float on their upstream tag (`upstream`): CI resolves
 * each tag to its index digest when it builds a release
 * (`scripts/data-image-digests.ts`), and that digest is what deploys. The tags
 * are the ones swarmy has always run; moving one is a deliberate BOM change.
 *
 * Pure data. The lookups are `data-images.ts`.
 */
import type { SystemImage } from './system-images';

/** Postgres majors swarmy offers (swarmy.yaml `version`, `db.provision` `imageTag`). */
export const POSTGRES_MAJORS = ['14', '15', '16', '17'] as const;

export type DataImageKey =
  | 'postgres14'
  | 'postgres15'
  | 'postgres16'
  | 'postgres17'
  | 'valkey'
  | 'redis'
  | 'meilisearch'
  | 'typesense'
  | 'qdrant'
  | 'restic'
  | 'walg'
  | 'pgbouncer'
  | 'alpine';

/**
 * What swarmy runs the image for. The first four are engines; `pooler` is a
 * long-running sidecar in front of an engine; `backup` and `volume` are
 * one-shot helpers.
 */
export type DataImageRole = 'postgres' | 'cache' | 'search' | 'vector' | 'pooler' | 'backup' | 'volume';
export type DataEngine = 'postgres' | 'valkey' | 'redis' | 'meilisearch' | 'typesense' | 'qdrant';

export interface DataImage extends SystemImage {
  key: DataImageKey;
  role: DataImageRole;
  /** The engine it runs (an engine) or works on (a Postgres-only helper). Absent: engine-agnostic. */
  engine?: DataEngine;
  /** The engine majors swarmy offers on this image. */
  majors: readonly string[];
  /** The engine's default when nobody picks a version (only needed where an engine has several majors). */
  default?: true;
}

const UPSTREAM = { upstream: true, bundleOnly: true } as const;

export const DATA_IMAGES: readonly DataImage[] = [
  // Managed Postgres: the official postgres image plus pgvector, rebuilt by the
  // pgvector project on every upstream release (protocol/dbBackup.ts says why).
  // The same image is the pg_dump / psql / pg_basebackup client.
  { key: 'postgres14', ref: 'pgvector/pgvector:pg14', role: 'postgres', engine: 'postgres', majors: ['14'], ...UPSTREAM },
  { key: 'postgres15', ref: 'pgvector/pgvector:pg15', role: 'postgres', engine: 'postgres', majors: ['15'], ...UPSTREAM },
  { key: 'postgres16', ref: 'pgvector/pgvector:pg16', role: 'postgres', engine: 'postgres', majors: ['16'], ...UPSTREAM },
  { key: 'postgres17', ref: 'pgvector/pgvector:pg17', role: 'postgres', engine: 'postgres', majors: ['17'], default: true, ...UPSTREAM },
  // Caches and queues (sentinels run the engine's own `*-sentinel` from the same image).
  { key: 'valkey', ref: 'valkey/valkey:8', digest: 'sha256:640c5e62cea04b6d6f2084232651d0cc70362d31f4f805e7be94dbed6855e8f2', role: 'cache', engine: 'valkey', majors: ['8'] },
  { key: 'redis', ref: 'redis:7.4', role: 'cache', engine: 'redis', majors: ['7'], ...UPSTREAM },
  { key: 'meilisearch', ref: 'getmeili/meilisearch:v1.12', role: 'search', engine: 'meilisearch', majors: ['1'], ...UPSTREAM },
  { key: 'typesense', ref: 'typesense/typesense:27.1', role: 'search', engine: 'typesense', majors: ['27'], ...UPSTREAM },
  { key: 'qdrant', ref: 'qdrant/qdrant:v1.12.6', role: 'vector', engine: 'qdrant', majors: ['1'], ...UPSTREAM },
  // Backups: restic stores every volume backup and DB dump; wal-g is managed
  // Postgres PITR. wal-g ships binaries, not images, so swarmy builds this from
  // the checksum-verified v3.0.3 Postgres build (docker/walg); CI's
  // platform.json pins its digest like swarmy's other builds.
  { key: 'restic', ref: 'restic/restic:0.16.4', digest: 'sha256:dad38b8042cfb1a759a958ed0061b888ebd05b1e780125a1fb4e2d687c6c0556', role: 'backup', majors: [] },
  { key: 'walg', ref: 'ghcr.io/requestflo/swarmy-walg:latest', role: 'backup', engine: 'postgres', majors: POSTGRES_MAJORS },
  // The optional connection pooler in front of a managed Postgres writer
  // (`swarmy.db.pooler`, manageddb-pooler*.ts). PgBouncer publishes source
  // tarballs, not images; edoburu/pgbouncer is the long-standing minimal
  // Alpine build of each release (it ships psql + pg_isready, runs as
  // `postgres`). swarmy writes its own pgbouncer.ini, so only the binary and
  // the user are relied on. v1.26.1-p0 = PgBouncer 1.26.1, the index digest
  // read from Docker Hub on 2026-10-26. It serves every Postgres major.
  { key: 'pgbouncer', ref: 'edoburu/pgbouncer:v1.26.1-p0', digest: 'sha256:488422e38cff912895d0d65d8963fcd306e6ac589a724398b6eb8e294e94d624', role: 'pooler', engine: 'postgres', majors: POSTGRES_MAJORS },
  // Volume moves, decommission drains and the operator's tar export copy data with it.
  { key: 'alpine', ref: 'alpine:3.20', role: 'volume', majors: [], ...UPSTREAM },
];
