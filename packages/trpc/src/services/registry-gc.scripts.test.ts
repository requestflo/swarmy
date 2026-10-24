import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRegistryOutput,
  renderRegistryCollectScript,
  renderRegistryDeleteScript,
  renderRegistryScanScript,
} from './registry-gc.scripts';

const hex = (c: string) => c.repeat(64);
const D = (c: string) => `sha256:${hex(c)}`;

/** A registry:2 filesystem layout: tags → current link, revisions, blobs. */
function fakeRegistry(): string {
  const root = mkdtempSync(join(tmpdir(), 'swarmy-reg-'));
  const v2 = join(root, 'docker/registry/v2');
  const blob = (c: string, body: string) => {
    const dir = join(v2, 'blobs/sha256', hex(c).slice(0, 2), hex(c));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data'), body);
  };
  const repo = (name: string, tags: Record<string, string>, revs: string[]) => {
    const m = join(v2, 'repositories', name, '_manifests');
    for (const [tag, c] of Object.entries(tags)) {
      mkdirSync(join(m, 'tags', tag, 'current'), { recursive: true });
      writeFileSync(join(m, 'tags', tag, 'current/link'), D(c)); // no trailing newline, like registry:2
    }
    for (const c of revs) {
      mkdirSync(join(m, 'revisions/sha256', hex(c)), { recursive: true });
      writeFileSync(join(m, 'revisions/sha256', hex(c), 'link'), D(c));
    }
  };
  // app: a (tagged), b (untagged leftover), i (tagged multi-arch index) → c (its untagged child).
  repo('app', { main: 'a', multi: 'i', 'sha256-aaaa.sig': 'f' }, ['a', 'b', 'c', 'i', 'f']);
  blob('a', '{"layers":[{"digest":"sha256:' + hex('9') + '"}]}');
  blob('b', '{"layers":[]}');
  blob('i', `{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"${D('c')}"}]}`);
  // team/web: one image + a build-cache tag (not counted as an image).
  repo('team/web', { v1: 'd', 'buildcache-root-main': 'e' }, ['d', 'e']);
  return root;
}

describe('registry GC scripts', () => {
  const root = fakeRegistry();
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('scan lists only manifests no tag and no index points at, plus counts', () => {
    const run = Bun.spawnSync(['sh', '-c', renderRegistryScanScript(400, root)]);
    const out = parseRegistryOutput(run.stdout.toString());
    expect(out.untagged.map((u) => `${u.repo}@${u.digest}`)).toEqual([`app@${D('b')}`]);
    expect(out.untagged[0]?.modifiedAt.getTime()).toBeGreaterThan(0);
    expect(out.stats).toMatchObject({ repos: 2, images: 3 }); // main, multi, v1
    expect(out.stats?.sizeBytes).toBeGreaterThan(0);
  });

  it('collect runs a plain mark-and-sweep (never --delete-untagged) and reports the size before', () => {
    const s = renderRegistryCollectScript();
    expect(s).toContain('registry garbage-collect /etc/docker/registry/config.yml');
    expect(s).not.toContain('delete-untagged');
    const out = parseRegistryOutput(['@@SWARMY-REG-BEFORE@@ 2048', '@@SWARMY-REG-GC@@ 0', '@@SWARMY-REG-STATS@@ 1024 2 5'].join('\n'));
    expect(out).toMatchObject({ beforeBytes: 2048 * 1024, gcExit: 0, stats: { sizeBytes: 1024 * 1024, repos: 2, images: 5 } });
  });

  it('delete goes through the registry API per manifest and drops its signature tag', () => {
    const s = renderRegistryDeleteScript([{ repo: 'team/web', digest: D('d'), reason: 'policy' }], 'localhost:5000');
    expect(s).toContain(`regctl manifest delete 'localhost:5000/team/web@${D('d')}'`);
    expect(s).toContain(`regctl tag delete 'localhost:5000/team/web:sha256-${hex('d')}.sig'`);
  });

  it('delete refuses anything that is not a repo name + sha256 digest', () => {
    const s = renderRegistryDeleteScript(
      [
        { repo: "app'; rm -rf /", digest: D('a'), reason: 'untagged' },
        { repo: 'app', digest: 'latest', reason: 'untagged' },
      ],
      'localhost:5000',
    );
    expect(s).not.toContain('manifest delete');
  });

  it('parse ignores garbled, truncated and undated lines', () => {
    const out = parseRegistryOutput(
      [`REG-UNTAGGED@@ app ${D('a')} 100`, `@@SWARMY-REG-UNTAGGED@@ app ${D('b')} 0`, '@@SWARMY-REG-UNTAGGED@@ App sha256:x 5', `@@SWARMY-REG-DELETED@@ app@${D('c')}`].join('\n'),
    );
    expect(out.untagged).toEqual([]);
    expect(out.deleted).toEqual([`app@${D('c')}`]);
    expect(out.stats).toBeNull();
  });
});
