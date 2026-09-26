/**
 * QA-075b: the disk re-attach script, run for real in `sh` against temp dirs
 * with stub mount/umount/lsblk/blkid/rsync on PATH. A "mount" swaps the empty
 * mountpoint dir for a symlink to the fake disk and appends a line to a fake
 * /proc/1/mountinfo, so the script's own host check sees it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DISK_FSTAB_OPTIONS,
  parsePending,
  parseRepaired,
  renderPendingProbeScript,
  renderRepairScript,
  swarmyFsLabel,
} from './disk-inventory';

const SERIAL = 'AB12345678';
const STAMP = '20260926T101500Z';
const MM = '8:16';

const STUBS: Record<string, string> = {
  lsblk: `case "$*" in
  *"-o TYPE"*) echo disk ;;
  *"-o SERIAL"*) echo "  $STUB_SERIAL" ;;
  *"MAJ:MIN"*) echo " $STUB_MM" ;;
  *MOUNTPOINT*) echo "" ;;
esac`,
  blkid: `case "$*" in
  *"-s TYPE"*) echo ext4 ;;
  *"-s LABEL"*) echo "$STUB_LABEL" ;;
  *"-s UUID"*) echo uuid-1 ;;
esac`,
  mount: `# mount -t ext4 DEV DIR
DEV="$3"; DIR="$4"
[ "\${STUB_MOUNT_FAIL:-}" != "$DIR" ] || { echo "stub mount: failed" >&2; exit 32; }
[ -d "$DIR" ] && [ -z "$(ls -A "$DIR")" ] || { echo "stub mount: $DIR is not an empty dir" >&2; exit 32; }
rmdir "$DIR" && ln -s "$STUB_DISK" "$DIR"
echo "36 25 $STUB_MM / $DIR rw - ext4 $DEV rw" >> "$STUB_MOUNTINFO"`,
  umount: `DIR="$1"
[ -L "$DIR" ] || { echo "stub umount: $DIR not mounted" >&2; exit 32; }
rm "$DIR" && mkdir "$DIR"
awk -v m="$DIR" '$5 != m' "$STUB_MOUNTINFO" > "$STUB_MOUNTINFO.t" && mv "$STUB_MOUNTINFO.t" "$STUB_MOUNTINFO"`,
  rsync: `echo "$*" >> "$STUB_LOG"
for a in "$@"; do SRC="$DST"; DST="$a"; done
cp -R "$SRC." "$DST" || exit 23
[ -z "\${STUB_RSYNC_DROP:-}" ] || rm -f "$DST$STUB_RSYNC_DROP"`,
  systemctl: 'exit 0',
};

let dir: string;
let root: string;
let mnt: string;
let disk: string;
let mountinfo: string;
let fstab: string;
let log: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swarmy-repair-'));
  root = join(dir, 'disks') + '/';
  mnt = `${root}${SERIAL}`;
  disk = join(dir, 'the-disk');
  mountinfo = join(dir, 'mountinfo');
  fstab = join(dir, 'fstab');
  log = join(dir, 'rsync.log');
  bin = join(dir, 'bin');
  await mkdir(root, { recursive: true });
  await mkdir(disk);
  await mkdir(join(disk, 'lost+found'));
  await mkdir(bin);
  await writeFile(mountinfo, '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n');
  await writeFile(fstab, `UUID=root-1 / ext4 defaults 0 1\nUUID=uuid-1 ${mnt} ext4 defaults,nofail 0 2\n`);
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(extraEnv: Record<string, string> = {}, label = swarmyFsLabel(SERIAL), onlyIfEmptyAndInFstab = false) {
  const script = renderRepairScript({ path: '/dev/sdb', serial: SERIAL, stamp: STAMP, onlyIfEmptyAndInFstab }, { root, mountinfo, fstab })
    // The host-namespace guard is covered in disk-inventory.test.ts; a CI
    // runner may not be allowed to read PID 1's namespace.
    .replace(/^if \[ -e \/proc\/1\/ns\/mnt \][\s\S]*?^fi$/m, '');
  const p = Bun.spawnSync(['sh', '-c', script], {
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      STUB_SERIAL: SERIAL,
      STUB_LABEL: label,
      STUB_MM: MM,
      STUB_DISK: disk,
      STUB_MOUNTINFO: mountinfo,
      STUB_LOG: log,
      ...extraEnv,
    },
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

/** Everything under a dir: `path size` for files, `path/` for dirs, `path -> target` for links. */
async function tree(base: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(base, rel))).sort()) {
    const p = rel ? `${rel}/${name}` : name;
    const st = await lstat(join(base, p));
    if (st.isSymbolicLink()) out.push(`${p} -> ${await readlink(join(base, p))}`);
    else if (st.isDirectory()) out.push(`${p}/`, ...(await tree(base, p)));
    else out.push(`${p} ${st.size}`);
  }
  return out;
}

async function seedRootDiskData(): Promise<string[]> {
  await mkdir(join(mnt, 'volumes', 'shop_db-primary-data', 'pgdata'), { recursive: true });
  await mkdir(join(mnt, 'volumes', 'empty-vol'), { recursive: true });
  await writeFile(join(mnt, 'volumes', 'shop_db-primary-data', 'pgdata', 'PG_VERSION'), '17\n');
  await writeFile(join(mnt, 'volumes', 'shop_db-primary-data', 'pgdata', 'base.dat'), 'x'.repeat(5000));
  await symlink('PG_VERSION', join(mnt, 'volumes', 'shop_db-primary-data', 'pgdata', 'link'));
  return tree(mnt);
}

const fstabLinesFor = async (m: string) => (await readFile(fstab, 'utf8')).split('\n').filter((l) => l.includes(` ${m} `));
const hostMounted = async (m: string) => (await readFile(mountinfo, 'utf8')).split('\n').some((l) => l.split(' ')[4] === m);

describe('renderRepairScript (QA-075b), in a real shell', () => {
  it('a non-empty mountpoint is copied, verified, set aside (not deleted) and the disk mounted', async () => {
    const before = await seedRootDiskData();
    const r = run();
    expect(r.out).not.toContain('__SWARMY_ERR__');
    expect(r.code).toBe(0);
    const res = parseRepaired(r.out);
    expect(res).toEqual({ uuid: 'uuid-1', moved: true, files: 2, bytes: 5003, aside: `${mnt}.pre-mount-${STAMP}` });

    // The originals are all still there, set aside on the root disk.
    expect(await tree(res!.aside!)).toEqual(before);
    // The disk now holds every file, dir and symlink (plus its own lost+found).
    const onDisk = await tree(disk);
    for (const entry of before) expect(onDisk).toContain(entry);
    expect(onDisk).toContain('lost+found/');
    // Mounted where the host sees it, fstab written for it once (and the root line kept).
    expect(await hostMounted(mnt)).toBe(true);
    expect(await fstabLinesFor(mnt)).toEqual([`UUID=uuid-1 ${mnt} ext4 ${DISK_FSTAB_OPTIONS} 0 2`]);
    expect(await readFile(fstab, 'utf8')).toContain('UUID=root-1 / ext4 defaults 0 1');
    // The temporary mount is gone and rsync ran with the full-fidelity flags.
    expect(await hostMounted(`${root}.repair-${SERIAL}`)).toBe(false);
    expect(existsSync(`${root}.repair-${SERIAL}`)).toBe(false);
    expect(await readFile(log, 'utf8')).toContain(`-aHAX --numeric-ids --backup --suffix=.pre-repair-${STAMP}`);
  }, 30_000);

  it('an empty mountpoint is mounted directly (no copy, nothing set aside)', async () => {
    await mkdir(mnt);
    const r = run();
    expect(r.code).toBe(0);
    expect(parseRepaired(r.out)).toEqual({ uuid: 'uuid-1', moved: false, files: 0, bytes: 0, aside: null });
    expect(existsSync(log)).toBe(false);
    expect(await hostMounted(mnt)).toBe(true);
    expect(await fstabLinesFor(mnt)).toEqual([`UUID=uuid-1 ${mnt} ext4 ${DISK_FSTAB_OPTIONS} 0 2`]);
    expect(existsSync(join(disk, 'volumes'))).toBe(true);
  }, 30_000);

  it('a copy that does not match aborts: nothing mounted, originals in place, a clear error', async () => {
    const before = await seedRootDiskData();
    const r = run({ STUB_RSYNC_DROP: 'volumes/shop_db-primary-data/pgdata/base.dat' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('__SWARMY_ERR__ the copy on the disk does not match the originals');
    expect(r.out).toContain('base.dat');
    expect(r.out).toContain('__SWARMY_ROLLED_BACK__');
    expect(parseRepaired(r.out)).toBeNull();
    // Nothing moved, nothing mounted, nothing deleted.
    expect(await tree(mnt)).toEqual(before);
    expect(existsSync(`${mnt}.pre-mount-${STAMP}`)).toBe(false);
    expect(await hostMounted(mnt)).toBe(false);
    expect(await hostMounted(`${root}.repair-${SERIAL}`)).toBe(false);
    expect(existsSync(`${root}.repair-${SERIAL}`)).toBe(false);
    // The stale line (it would hide the files on the next boot) stays removed.
    expect(await fstabLinesFor(mnt)).toEqual([]);
  }, 30_000);

  it('a failed final mount moves the originals back', async () => {
    const before = await seedRootDiskData();
    const r = run({ STUB_MOUNT_FAIL: mnt });
    expect(r.code).toBe(3);
    expect(r.out).toContain(`mounting /dev/sdb at ${mnt} failed`);
    expect(await tree(mnt)).toEqual(before);
    expect(existsSync(`${mnt}.pre-mount-${STAMP}`)).toBe(false);
    expect(await hostMounted(mnt)).toBe(false);
  }, 30_000);

  it('refuses a disk without swarmy’s label, or when something is mounted there already', async () => {
    await seedRootDiskData();
    const wrong = run({}, 'other');
    expect(wrong.code).toBe(3);
    expect(wrong.out).toContain("does not carry swarmy's label");
    expect(existsSync(log)).toBe(false);

    await writeFile(mountinfo, `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n40 22 8:32 / ${mnt} rw - ext4 /dev/sdc rw\n`);
    const busy = run();
    expect(busy.code).toBe(3);
    expect(busy.out).toContain(`something is already mounted at ${mnt}`);
    expect(existsSync(log)).toBe(false);
  }, 30_000);
});

describe('renderRepairScript at agent start (QA-085: a disk back after a reboot, not mounted)', () => {
  it('an empty mountpoint the fstab declares is mounted, fstab rewritten after the host check', async () => {
    await mkdir(mnt);
    const r = run({}, undefined, true);
    expect(r.out).not.toContain('__SWARMY_ERR__');
    expect(parseRepaired(r.out)).toMatchObject({ moved: false, aside: null });
    expect(await hostMounted(mnt)).toBe(true);
    expect(await fstabLinesFor(mnt)).toEqual([`UUID=uuid-1 ${mnt} ext4 ${DISK_FSTAB_OPTIONS} 0 2`]);
    expect(existsSync(log)).toBe(false);
  }, 30_000);

  it('a missing mountpoint dir is fine too', async () => {
    expect(run({}, undefined, true).code).toBe(0);
    expect(await hostMounted(mnt)).toBe(true);
  }, 30_000);

  it('leaves a non-empty mountpoint, or one this box’s fstab does not declare, to the controller', async () => {
    const before = await seedRootDiskData();
    const full = run({}, undefined, true);
    expect(full.code).toBe(3);
    expect(full.out).toContain('leaving the move to the controller');
    expect(await tree(mnt)).toEqual(before);
    expect(await hostMounted(mnt)).toBe(false);
    expect(existsSync(log)).toBe(false);

    await rm(mnt, { recursive: true });
    await writeFile(fstab, 'UUID=root-1 / ext4 defaults 0 1\n');
    const undeclared = run({}, undefined, true);
    expect(undeclared.code).toBe(3);
    expect(undeclared.out).toContain("not in this server's fstab");
    expect(await hostMounted(mnt)).toBe(false);
  }, 30_000);
});

describe('renderPendingProbeScript', () => {
  it('counts what was written to the bare mountpoint, or says it is mounted', async () => {
    await seedRootDiskData();
    const script = renderPendingProbeScript([SERIAL, 'CD000000', 'EF000000'], { root, mountinfo });
    await writeFile(mountinfo, `22 1 8:1 / / rw - ext4 /dev/sda1 rw\n40 22 8:32 / ${root}CD000000 rw - ext4 /dev/sdc rw\n`);
    const p = Bun.spawnSync(['sh', '-c', script]);
    const pending = parsePending(p.stdout.toString());
    expect(pending[mnt]).toEqual({ mounted: false, files: 2, bytes: 5003 });
    expect(pending[`${root}CD000000`]).toEqual({ mounted: true, files: 0, bytes: 0 });
    expect(pending[`${root}EF000000`]).toEqual({ mounted: false, files: 0, bytes: 0 });
  }, 30_000);
});

describe('renderRepairScript: static guarantees', () => {
  const s = renderRepairScript({ path: '/dev/sdb', serial: SERIAL, stamp: STAMP });
  it('runs in the host namespace, checks the host view, and writes fstab only after', () => {
    expect(s).toContain('"$(readlink /proc/self/ns/mnt)" != "$(readlink /proc/1/ns/mnt)"');
    const finalMount = s.indexOf('mount -t ext4 "$DEV" "$MNT"');
    const check = s.indexOf("'/proc/1/mountinfo')\n[ -n \"$HOST_MM\" ]");
    const fstabAdd = s.indexOf('echo "UUID=$UUID $MNT ext4');
    expect(finalMount).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(finalMount);
    expect(fstabAdd).toBeGreaterThan(check);
  });
  it('never deletes: no rm of the mountpoint or the set-aside dir', () => {
    expect(s).not.toMatch(/rm -r?f? "\$(MNT|ASIDE)"/);
    expect(s).not.toContain('--delete');
  });
  it('refuses odd inputs', () => {
    expect(() => renderRepairScript({ path: '/dev/sdb;x', serial: SERIAL, stamp: STAMP })).toThrow();
    expect(() => renderRepairScript({ path: '/dev/sdb', serial: SERIAL, stamp: '$(reboot)' })).toThrow();
  });
});
