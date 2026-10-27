import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';
import type { DbWalgCopyPayload } from '@swarmy/core/protocol';
import { physicalEnv } from './backup';
import { COPY_DONE, dbWalgCopy, parseCopyOutput, sideEnv, walgCopyScript } from './walg-copy';
import { WAL_LISTING_MARKER } from './pitr-window';

/**
 * The wal-g copy reads both storages from env only: the rendered script is
 * run against a stub `wal-g` that records argv and the two config files it
 * was handed, so the quoting of a hostile secret, "LATEST", and the copy's
 * own window are proven without a bucket.
 */

const FROM = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp', accessKeyId: 'GK1', secretAccessKey: 'main-secret' };
const TO = { kind: 's3' as const, repo: 's3:https://acct.r2.cloudflarestorage.com/offsite/pg', password: 'rp2', accessKeyId: 'AK2', secretAccessKey: `it's "tricky" $HOME`, region: 'auto' };
const STUB = `#!/bin/sh
echo "$*" >> "$REC/argv"
case "$3" in
  copy) cp "$5" "$REC/from.yaml"; cp "$7" "$REC/to.yaml"; echo "INFO: copying" ;;
  backup-list) if [ "$4" = "--json" ]; then echo '[{"backup_name":"base_02","finish_time":"2026-10-27T03:00:00Z"}]'; else printf 'name modified wal_segment_backup_start\\nbase_01 a b\\nbase_02 a b\\n'; fi ;;
  st) echo 'obj 1024 2026-10-27 03:04:00 +0000 UTC wal_005/000000010000000000000002.lz4' ;;
esac
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function runScript(name: string): Promise<{ stdout: string; rec: string; shm: string; code: number }> {
  const [bin, rec, shm] = ['bin', 'rec', 'shm'].map((p) => mkdtempSync(path.join(tmpdir(), `walg-copy-${p}-`)));
  dirs.push(bin!, rec!, shm!);
  writeFileSync(path.join(bin!, 'wal-g'), STUB);
  chmodSync(path.join(bin!, 'wal-g'), 0o755);
  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, REC: rec!, SWARMY_SHM: shm!, SWARMY_BACKUP_NAME: name };
  for (const kv of [...sideEnv('FROM', physicalEnv(FROM).env), ...sideEnv('TO', physicalEnv(TO).env)]) env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
  delete env.SWARMY_FROM_SWARMY_S3_HOST; // no getent preflight against names the test box can't resolve
  delete env.SWARMY_TO_SWARMY_S3_HOST;
  const proc = Bun.spawn(['/bin/sh', '-c', walgCopyScript()], { env, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  return { stdout, rec: rec!, shm: shm!, code: await proc.exited };
}

describe('walgCopyScript against a stub wal-g', () => {
  it('writes each side’s config from env, quoting a hostile secret, and never puts a value on argv', async () => {
    const r = await runScript('base_01');
    expect(r.code).toBe(0);
    const argv = readFileSync(path.join(r.rec, 'argv'), 'utf8');
    expect(argv).toContain('copy --from');
    expect(argv).toContain('--backup-name base_01');
    expect(argv).not.toContain('secret');
    expect(argv).not.toContain('tricky');
    expect(readFileSync(path.join(r.rec, 'from.yaml'), 'utf8')).toBe(
      "WALG_S3_PREFIX: 's3://bkt/pfx'\nAWS_ENDPOINT: 'http://swarmy-garage:3900'\nAWS_S3_FORCE_PATH_STYLE: 'true'\nAWS_ACCESS_KEY_ID: 'GK1'\nAWS_SECRET_ACCESS_KEY: 'main-secret'\n",
    );
    expect(readFileSync(path.join(r.rec, 'to.yaml'), 'utf8')).toContain(`AWS_SECRET_ACCESS_KEY: 'it''s "tricky" $HOME'\nAWS_REGION: 'auto'\n`);
    // The configs lived on the tmpfs only for the run.
    expect(existsSync(path.join(r.shm, 'swarmy-walg-copy'))).toBe(false);
    expect(parseCopyOutput(r.stdout, '2026-10-27T03:05:00.000Z')).toMatchObject({
      backupName: 'base_01',
      window: { from: '2026-10-27T03:00:00.000Z', to: '2026-10-27T03:04:00.000Z' },
    });
  });

  it('LATEST copies the newest base backup in the main destination', async () => {
    const r = await runScript('LATEST');
    expect(readFileSync(path.join(r.rec, 'argv'), 'utf8')).toContain('--backup-name base_02');
    expect(parseCopyOutput(r.stdout, 'x').backupName).toBe('base_02');
  });
});

describe('parseCopyOutput', () => {
  it('a run that never reported its copy is a failure', () => {
    expect(() => parseCopyOutput(`[]\n${WAL_LISTING_MARKER}\n`, 'x')).toThrow(/did not report/);
    expect(parseCopyOutput(`${COPY_DONE} base_09\n\n${WAL_LISTING_MARKER}\n`, 'x')).toMatchObject({ backupName: 'base_09', backups: [], window: null });
  });
});

describe('dbWalgCopy', () => {
  it('one sidecar, no volume, both sides as prefixed env, the storage overlay; refuses a node repo', async () => {
    const created: Array<{ Cmd: string[]; Env: string[]; HostConfig: { Binds: string[]; NetworkMode?: string } }> = [];
    const stdout = `${COPY_DONE} base_01\n[]\n${WAL_LISTING_MARKER}\n`;
    const docker = {
      pullImage: async () => undefined,
      docker: {
        getNetwork: () => ({ connect: async () => undefined }),
        modem: { demuxStream: (_s: unknown, o: { write(b: Buffer): void }) => o.write(Buffer.from(stdout)) },
        createContainer: async (o: (typeof created)[number]) => {
          created.push(o);
          return { id: 'c1', attach: async () => ({}), start: async () => undefined, wait: async () => ({ StatusCode: 0 }), kill: async () => undefined, remove: async () => undefined };
        },
      },
    } as unknown as DockerClient;
    const p: DbWalgCopyPayload = { commandId: 'c1', engine: 'wal-g', from: FROM, to: TO, backupName: 'base_01', resticNetwork: 'swarmy' };
    expect((await dbWalgCopy(docker, p)).backupName).toBe('base_01');
    expect(created[0]!.HostConfig.Binds).toEqual([]);
    expect(created[0]!.HostConfig.NetworkMode).toBe('swarmy');
    expect(created[0]!.Cmd).toEqual([walgCopyScript()]);
    expect(created[0]!.Env).toContain('SWARMY_TO_AWS_SECRET_ACCESS_KEY=it\'s "tricky" $HOME');
    expect(created[0]!.Env).not.toContain('AWS_SECRET_ACCESS_KEY=main-secret');
    await expect(dbWalgCopy(docker, { ...p, to: { kind: 'node', repo: '/srv/backups', password: 'x' } })).rejects.toThrow(/S3 target/);
    await expect(dbWalgCopy(docker, { ...p, backupName: '--delete-all' })).rejects.toThrow(/unsafe/);
  });
});
