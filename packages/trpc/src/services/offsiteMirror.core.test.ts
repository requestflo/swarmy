import { describe, expect, test } from 'bun:test';
import {
  BUCKET_MARKER,
  buildMirrorRunOnce,
  EXIT_MARKER,
  isMirrorDue,
  LIST_MARKER,
  MIRROR_TIMEOUT_MS,
  nextMirrorRun,
  normalizePrefix,
  offsiteRoot,
  offsiteTargetProblem,
  parseMirrorOutput,
  parseOffsiteBucketList,
  planMirrorBuckets,
  PURGE_MARKER,
  RCLONE_IMAGE,
  rcloneRemoteEnv,
  restoreGuard,
  s3ProviderFor,
  summarizeRun,
  TRASH_DIR,
  type OffsiteTargetLike,
} from './offsiteMirror.core';

const SOURCE = {
  endpoint: 'http://swarmy-garage:3900',
  region: 'swarmy',
  accessKeyId: 'GKsourceaccess',
  secretAccessKey: 'garage-secret-VALUE',
  provider: 'Other',
};
const OFFSITE = {
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  region: 'eu-central-003',
  accessKeyId: 'b2-key-id-123',
  secretAccessKey: 'b2-application-key-SECRET',
};

describe('rclone env config builder', () => {
  test('a remote is configured entirely through RCLONE_CONFIG_<REMOTE>_* env', () => {
    const env = rcloneRemoteEnv('offsite', OFFSITE);
    expect(env).toEqual({
      RCLONE_CONFIG_OFFSITE_TYPE: 's3',
      RCLONE_CONFIG_OFFSITE_PROVIDER: 'Other',
      RCLONE_CONFIG_OFFSITE_ENV_AUTH: 'false',
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: 'b2-key-id-123',
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: 'b2-application-key-SECRET',
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: 'true',
      RCLONE_CONFIG_OFFSITE_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
      RCLONE_CONFIG_OFFSITE_REGION: 'eu-central-003',
      RCLONE_CONFIG_OFFSITE_FORCE_PATH_STYLE: 'true',
    });
  });

  test('provider is derived from the endpoint', () => {
    expect(s3ProviderFor(null)).toBe('AWS');
    expect(s3ProviderFor('https://s3.us-east-1.amazonaws.com')).toBe('AWS');
    expect(s3ProviderFor('https://abc123.r2.cloudflarestorage.com')).toBe('Cloudflare');
    expect(s3ProviderFor('s3.eu-central-1.wasabisys.com')).toBe('Wasabi');
    expect(s3ProviderFor('https://s3.us-west-004.backblazeb2.com')).toBe('Other');
    // AWS keeps virtual-host addressing
    expect(rcloneRemoteEnv('x', { ...OFFSITE, endpoint: null }).RCLONE_CONFIG_X_FORCE_PATH_STYLE).toBeUndefined();
  });

  test('no secret, key id, or bucket name ever reaches argv', () => {
    for (const direction of ['mirror', 'restore', 'list'] as const) {
      const p = buildMirrorRunOnce({
        direction,
        source: SOURCE,
        offsite: OFFSITE,
        root: 'acme-dr/swarmy-mirror',
        buckets: ['swarmy-backups', 'swarmy-edge-certs'],
        copyOnly: ['swarmy-edge-certs'],
        mode: 'sync',
        runId: 'run1',
        network: 'swarmy',
      });
      const argv = JSON.stringify([p.entrypoint, p.cmd, p.image]);
      for (const secret of [
        SOURCE.secretAccessKey,
        SOURCE.accessKeyId,
        OFFSITE.secretAccessKey,
        OFFSITE.accessKeyId,
        'swarmy-backups',
        'acme-dr',
      ]) {
        expect(argv).not.toContain(secret);
      }
      // …they ride env instead
      expect(p.env.RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY).toBe(OFFSITE.secretAccessKey);
      expect(p.image).toBe(RCLONE_IMAGE);
      expect(p.networks).toEqual(['swarmy']);
    }
  });

  test('mirror payload: garage remote, checksum + bounded flags, hard timeout', () => {
    const p = buildMirrorRunOnce({
      direction: 'mirror',
      source: SOURCE,
      offsite: OFFSITE,
      root: 'acme-dr/swarmy-mirror',
      buckets: ['a-bucket'],
      network: 'swarmy',
    });
    expect(p.env.RCLONE_CONFIG_GARAGE_ENDPOINT).toBe('http://swarmy-garage:3900');
    expect(p.env.RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY).toBe(SOURCE.secretAccessKey);
    expect(p.env.RCLONE_CHECKSUM).toBe('true');
    expect(p.env.RCLONE_TRANSFERS).toBe('4');
    expect(p.env.RCLONE_BWLIMIT).toBe('50M');
    expect(p.env.MIRROR_MODE).toBe('copy');
    expect(p.env.MIRROR_BUCKETS).toBe('a-bucket');
    expect(p.timeoutMs).toBe(MIRROR_TIMEOUT_MS);
    expect(p.cmd[0]).toContain('rclone copy "garage:$b" "offsite:$OFFSITE_ROOT/$b"');
    expect(p.cmd[0]).toContain(`--backup-dir "offsite:$OFFSITE_ROOT/${TRASH_DIR}/$MIRROR_RUN_ID/$b"`);
  });

  test('restore script only ever copies (never sync/delete) into garage', () => {
    const p = buildMirrorRunOnce({
      direction: 'restore',
      source: SOURCE,
      offsite: OFFSITE,
      root: 'r',
      buckets: ['a-bucket'],
      network: 'swarmy',
    });
    expect(p.cmd[0]).toContain('rclone copy "offsite:$OFFSITE_ROOT/$b" "garage:$b"');
    expect(p.cmd[0]).not.toContain('sync');
    expect(p.cmd[0]).not.toContain('delete');
  });

  test('list needs no garage credentials; mirror refuses without them', () => {
    const p = buildMirrorRunOnce({ direction: 'list', offsite: OFFSITE, root: 'r', buckets: [], network: 'swarmy' });
    expect(Object.keys(p.env).some((k) => k.startsWith('RCLONE_CONFIG_GARAGE_'))).toBe(false);
    expect(() =>
      buildMirrorRunOnce({ direction: 'mirror', offsite: OFFSITE, root: 'r', buckets: ['ab'], network: 'swarmy' }),
    ).toThrow();
  });

  test('rejects bucket names that could smuggle shell syntax', () => {
    expect(() =>
      buildMirrorRunOnce({
        direction: 'mirror',
        source: SOURCE,
        offsite: OFFSITE,
        root: 'r',
        buckets: ['ok-bucket', 'x; rm -rf /'],
        network: 'swarmy',
      }),
    ).toThrow(/invalid bucket/);
  });
});

describe('prefix + root', () => {
  test('defaults, trims slashes, rejects traversal', () => {
    expect(normalizePrefix(undefined)).toBe('swarmy-mirror');
    expect(normalizePrefix(' /dr/prod/ ')).toBe('dr/prod');
    expect(() => normalizePrefix('../etc')).toThrow();
    expect(() => normalizePrefix('a b')).toThrow();
    expect(offsiteRoot('acme-dr', 'swarmy-mirror')).toBe('acme-dr/swarmy-mirror');
  });
});

describe('schedule due logic', () => {
  const anchor = new Date('2026-09-01T00:00:00.000Z');
  test('hourly interval anchored to creation', () => {
    const from = new Date('2026-09-01T05:20:00.000Z');
    expect(nextMirrorRun(60, anchor, from).toISOString()).toBe('2026-09-01T06:00:00.000Z');
    // exactly on a boundary → the next one
    expect(nextMirrorRun(60, anchor, new Date('2026-09-01T06:00:00.000Z')).toISOString()).toBe(
      '2026-09-01T07:00:00.000Z',
    );
  });
  test('intervals below the floor clamp to 15 minutes', () => {
    expect(nextMirrorRun(1, anchor, anchor).toISOString()).toBe('2026-09-01T00:15:00.000Z');
  });
  test('due when nextRunAt passed or unset; never when paused or already running', () => {
    const now = new Date('2026-09-01T06:00:00.000Z');
    expect(isMirrorDue({ enabled: true, nextRunAt: null }, now, false)).toBe(true);
    expect(isMirrorDue({ enabled: true, nextRunAt: new Date('2026-09-01T05:59:00Z') }, now, false)).toBe(true);
    expect(isMirrorDue({ enabled: true, nextRunAt: new Date('2026-09-01T06:01:00Z') }, now, false)).toBe(false);
    expect(isMirrorDue({ enabled: false, nextRunAt: null }, now, false)).toBe(false);
    expect(isMirrorDue({ enabled: true, nextRunAt: null }, now, true)).toBe(false);
  });
});

describe('bucket plan', () => {
  const store = [
    { id: 'id-b', name: 'swarmy-backups', objects: 120 },
    { id: 'id-c', name: 'swarmy-edge-certs', objects: 0 },
    { id: 'id-a', name: 'app-uploads', objects: 5 },
  ];
  test('all = every bucket, sorted', () => {
    const p = planMirrorBuckets({ allBuckets: true, selected: [], mode: 'copy', store });
    expect(p.buckets.map((b) => b.name)).toEqual(['app-uploads', 'swarmy-backups', 'swarmy-edge-certs']);
    expect(p.copyOnly).toEqual([]);
  });
  test('sync downgrades an empty source bucket to copy (no mass delete off-site)', () => {
    const p = planMirrorBuckets({ allBuckets: true, selected: [], mode: 'sync', store });
    expect(p.copyOnly).toEqual(['swarmy-edge-certs']);
  });
  test('selected list reports buckets that vanished', () => {
    const p = planMirrorBuckets({ allBuckets: false, selected: ['swarmy-backups', 'gone'], mode: 'copy', store });
    expect(p.buckets).toEqual([{ id: 'id-b', name: 'swarmy-backups' }]);
    expect(p.missing).toEqual(['gone']);
  });
});

const B2: OffsiteTargetLike = {
  name: 'b2-dr',
  kind: 'S3',
  endpoint: 'https://s3.eu-central-003.backblazeb2.com',
  bucket: 'acme-dr',
  hasCredentials: true,
  inCluster: false,
};

describe('offsite target eligibility', () => {
  test('only external S3 targets with credentials qualify', () => {
    expect(offsiteTargetProblem(B2)).toBeNull();
    expect(offsiteTargetProblem({ ...B2, kind: 'NODE' })).toMatch(/node-path/);
    expect(offsiteTargetProblem({ ...B2, inCluster: true })).toMatch(/not off-site/);
    expect(offsiteTargetProblem({ ...B2, hasCredentials: false })).toMatch(/access keys/);
  });
});

describe('restore guard', () => {
  const ok = { confirm: 'b2-dr', target: B2, storeState: 'ready' as const, running: false };
  test('allows a confirmed restore into a ready store', () => {
    expect(restoreGuard(ok)).toBeNull();
    expect(restoreGuard({ ...ok, confirm: '  b2-dr ' })).toBeNull();
  });
  test('refuses without the typed destination name', () => {
    expect(restoreGuard({ ...ok, confirm: '' })).toMatch(/type the destination name "b2-dr"/);
    expect(restoreGuard({ ...ok, confirm: 'yes' })).toMatch(/confirm/);
  });
  test('refuses with no mirror, a bad target, a down store, or a run in flight', () => {
    expect(restoreGuard({ ...ok, target: null })).toMatch(/no off-site mirror/);
    expect(restoreGuard({ ...ok, target: { ...B2, inCluster: true } })).toMatch(/not off-site/);
    expect(restoreGuard({ ...ok, storeState: 'disabled' })).toMatch(/enable the replicated store/);
    expect(restoreGuard({ ...ok, storeState: 'unreachable' })).toMatch(/unreachable/);
    expect(restoreGuard({ ...ok, running: true })).toMatch(/already running/);
  });
});

const stats = (s: Record<string, unknown>) =>
  JSON.stringify({ level: 'notice', msg: 'stats', stats: s, time: '2026-09-01T00:00:00Z' });

describe('run output parsing + recording summary', () => {
  test('attributes each final stats line to its bucket', () => {
    const output = [
      `${BUCKET_MARKER}app-uploads`,
      stats({ bytes: 1024, transfers: 3, deletes: 0, errors: 0 }),
      `${EXIT_MARKER}0`,
      `${BUCKET_MARKER}swarmy-backups`,
      stats({ bytes: 50, transfers: 1, deletes: 2, errors: 0 }),
      `${EXIT_MARKER}0`,
      `${PURGE_MARKER}start`,
      stats({ bytes: 0, transfers: 0, deletes: 9, errors: 0 }),
      `${PURGE_MARKER}done`,
    ].join('\n');
    const s = summarizeRun({ exitCode: 0, output });
    expect(s.status).toBe('SUCCEEDED');
    expect(s.objectsCopied).toBe(4);
    expect(s.bytesCopied).toBe(1074);
    // trash purge deletes are NOT counted as mirrored deletes
    expect(s.deletes).toBe(2);
    expect(s.error).toBeNull();
    expect(s.buckets.map((b) => [b.bucket, b.exitCode])).toEqual([
      ['app-uploads', 0],
      ['swarmy-backups', 0],
    ]);
  });

  test('a failing bucket fails the run with its error', () => {
    const output = [
      `${BUCKET_MARKER}app-uploads`,
      JSON.stringify({ level: 'error', msg: 'AccessDenied: key lacks write' }),
      stats({ bytes: 0, transfers: 0, errors: 2, lastError: 'AccessDenied: key lacks write' }),
      `${EXIT_MARKER}7`,
    ].join('\n');
    const s = summarizeRun({ exitCode: 7, output });
    expect(s.status).toBe('FAILED');
    expect(s.errorCount).toBe(2);
    expect(s.error).toBe('app-uploads: AccessDenied: key lacks write');
  });

  test('a timed-out run is FAILED with a resumable message', () => {
    const s = summarizeRun({ exitCode: 137, output: `${BUCKET_MARKER}big`, timedOut: true });
    expect(s.status).toBe('FAILED');
    expect(s.error).toMatch(/timed out after 4h/);
    expect(s.errorCount).toBe(1);
  });

  test('offsite listing keeps bucket folders, drops trash + junk', () => {
    const out = `noise\n${LIST_MARKER}\napp-uploads/\n${TRASH_DIR}/\nswarmy-backups/\nREADME.txt\nBad_Name/\n`;
    expect(parseOffsiteBucketList(out)).toEqual(['app-uploads', 'swarmy-backups']);
  });

  test('stats parse tolerates a non-JSON tail', () => {
    expect(parseMirrorOutput(`${BUCKET_MARKER}x1\nnot json\n{broken`)).toEqual([
      { bucket: 'x1', objects: 0, bytes: 0, deletes: 0, errors: 0, exitCode: null },
    ]);
  });
});
