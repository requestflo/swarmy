import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { dataImage } from '@swarmy/core/data-images';
import { helperDefault, type ListSnapshotsPayload } from '@swarmy/core/protocol';
import { listSnapshots } from './backup';
import { dbPitrWindow } from './pitr-window';

/**
 * The backup/restore sidecars pull and run the image the controller pinned
 * (`<ref>@<digest>`); an older controller sends none, or the bare tag, and the
 * agent runs its own default (its compiled BOM, digest-pinned where it can).
 * A fake Docker records every pull and container create.
 */
function fakeDocker(stdout: string) {
  const pulled: string[] = [];
  const created: string[] = [];
  const docker = {
    pullImage: async (image: string) => void pulled.push(image),
    docker: {
      getImage: () => ({ inspect: async () => ({ Config: { User: '' } }) }),
      getNetwork: () => ({ connect: async () => undefined }),
      modem: { demuxStream: (_s: unknown, o: { write(b: Buffer): void }) => o.write(Buffer.from(stdout)) },
      createContainer: async (opts: { Image: string }) => {
        created.push(opts.Image);
        return {
          id: 'c',
          attach: async () => ({}),
          start: async () => undefined,
          wait: async () => ({ StatusCode: 0 }),
          remove: async () => undefined,
        };
      },
    },
  } as unknown as DockerClient;
  return { docker, pulled, created };
}

const D = (c: string) => `sha256:${c.repeat(64)}`;
const repo = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/b/p', password: 'p', accessKeyId: 'a', secretAccessKey: 's' };
const list = (image?: string): ListSnapshotsPayload => ({
  commandId: '00000000-0000-4000-8000-000000000001',
  repo,
  tags: [],
  ...(image ? { image } : {}),
});

describe('restic sidecars (volume backups, restores, listings)', () => {
  it("pull and run the controller's digest-pinned ref", async () => {
    const pinned = `${dataImage('restic').ref}@${D('e')}`;
    const f = fakeDocker('[]');
    await listSnapshots(f.docker, list(pinned));
    expect(f.pulled).toEqual([pinned, pinned]); // `restic init`, then `restic snapshots`
    expect(f.created).toEqual([pinned, pinned]);
  });

  it("an older controller's tag (or none) runs the agent's own pinned default", async () => {
    const own = helperDefault('restic');
    expect(own).toBe(`restic/restic:0.16.4@${dataImage('restic').digest}`);
    for (const sent of [undefined, dataImage('restic').ref]) {
      const f = fakeDocker('[]');
      await listSnapshots(f.docker, list(sent));
      expect(f.created).toEqual([own, own]);
    }
  });
});

describe('wal-g sidecars (PITR window reads, base backups, restores)', () => {
  const window = (engineImage?: string) => ({
    commandId: '00000000-0000-4000-8000-000000000002',
    engine: 'wal-g' as const,
    repo,
    ...(engineImage ? { engineImage } : {}),
  });

  it("run the controller's pinned wal-g, else the agent's default", async () => {
    const pinned = `${dataImage('walg').ref}@${D('a')}`;
    const f = fakeDocker('[]');
    await dbPitrWindow(f.docker, window(pinned));
    expect(f.created).toEqual([pinned]);
    const old = fakeDocker('[]');
    await dbPitrWindow(old.docker, window());
    expect(old.created).toEqual([helperDefault('walg')]);
  });
});
