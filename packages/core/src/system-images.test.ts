import { describe, expect, test } from 'bun:test';
import {
  MIRROR_FAIL_MARKER,
  MIRROR_NODE_LABEL,
  MIRROR_OK_MARKER,
  SYSTEM_IMAGES,
  copySourceFor,
  copyTargetFor,
  mirrorLabelKey,
  mirrorLabelsAfter,
  mirroredRefFor,
  parseImageRef,
  parseMirrorOutput,
  planMirror,
  renderMirrorScript,
  systemImage,
  type SystemImage,
} from './system-images';

const H = 'localhost:5000';
const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;
const pinned: SystemImage = { key: 'curl', ref: 'curlimages/curl:8.10.1', digest: D1 };
const floating: SystemImage = { key: 'dns', ref: 'ghcr.io/requestflo/swarmy-dns:latest' };
const reg: SystemImage = { key: 'registry', ref: 'registry:2', digest: D2, noRewrite: true };
const BOM = [pinned, floating, reg];

describe('BOM', () => {
  test('every entry has a unique key and ref, and pinned digests are well-formed', () => {
    expect(new Set(SYSTEM_IMAGES.map((i) => i.key)).size).toBe(SYSTEM_IMAGES.length);
    expect(new Set(SYSTEM_IMAGES.map((i) => i.ref)).size).toBe(SYSTEM_IMAGES.length);
    for (const i of SYSTEM_IMAGES) if (i.digest) expect(i.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  test('third-party images are digest-pinned; only swarmy builds (and wal-g) float', () => {
    const floating = SYSTEM_IMAGES.filter((i) => !i.digest).map((i) => i.key).sort();
    expect(floating).toEqual(['agent', 'caddySwarmy', 'controller', 'dns', 'walg']);
  });
  test('the registry and the copier are never rewritten to the mirror', () => {
    expect(systemImage('registry').noRewrite).toBe(true);
    expect(systemImage('regctl').noRewrite).toBe(true);
  });
});

describe('parseImageRef', () => {
  test('Hub shorthands normalise to docker.io/library', () => {
    expect(parseImageRef('busybox:1.36')).toEqual({ host: 'docker.io', path: 'library/busybox', tag: '1.36', digest: null });
    expect(parseImageRef('moby/buildkit:rootless').path).toBe('moby/buildkit');
  });
  test('registry hosts with ports and digests', () => {
    expect(parseImageRef(`localhost:5000/a/b@${D1}`)).toEqual({ host: 'localhost:5000', path: 'a/b', tag: null, digest: D1 });
    expect(parseImageRef('ghcr.io/x/y:latest').host).toBe('ghcr.io');
  });
});

describe('copy refs', () => {
  test('pinned copies by digest, floating by tag; the target keeps the upstream tag', () => {
    expect(copySourceFor(pinned)).toBe(`docker.io/curlimages/curl@${D1}`);
    expect(copySourceFor(floating)).toBe('ghcr.io/requestflo/swarmy-dns:latest');
    expect(copyTargetFor(pinned, H)).toBe('localhost:5000/swarmy-system/docker.io/curlimages/curl:8.10.1');
  });
});

describe('mirroredRefFor', () => {
  const labels = {
    [mirrorLabelKey('curl')]: `curlimages/curl:8.10.1@${D1}`,
    [mirrorLabelKey('dns')]: `ghcr.io/requestflo/swarmy-dns:latest@${D2}`,
    [mirrorLabelKey('registry')]: `registry:2@${D2}`,
    [MIRROR_NODE_LABEL]: 'n1',
  };
  test('an exact upstream ref rewrites to the mirror by digest', () => {
    expect(mirroredRefFor('curlimages/curl:8.10.1', H, labels, 'n1', BOM)).toBe(
      `localhost:5000/swarmy-system/docker.io/curlimages/curl@${D1}`,
    );
    expect(mirroredRefFor('ghcr.io/requestflo/swarmy-dns:latest', H, labels, 'n1', BOM)).toBe(
      `localhost:5000/swarmy-system/ghcr.io/requestflo/swarmy-dns@${D2}`,
    );
  });
  test('the registry moved nodes → its copies are gone → no rewrite', () => {
    expect(mirroredRefFor('curlimages/curl:8.10.1', H, labels, 'n2', BOM)).toBeNull();
    expect(mirroredRefFor('curlimages/curl:8.10.1', H, labels, null, BOM)).toBeNull();
  });
  test('non-system refs, excluded refs, and a BOM bump never rewrite', () => {
    expect(mirroredRefFor('nginx:1', H, labels, 'n1', BOM)).toBeNull();
    expect(mirroredRefFor('registry:2', H, labels, 'n1', BOM)).toBeNull();
    const bumped = [{ ...pinned, ref: 'curlimages/curl:8.11.0' }];
    expect(mirroredRefFor('curlimages/curl:8.11.0', H, labels, 'n1', bumped)).toBeNull();
  });
  test('a copy whose digest disagrees with the pin is not trusted', () => {
    const bad = { ...labels, [mirrorLabelKey('curl')]: `curlimages/curl:8.10.1@${D2}` };
    expect(mirroredRefFor('curlimages/curl:8.10.1', H, bad, 'n1', BOM)).toBeNull();
  });
});

describe('planMirror + labels', () => {
  test('pinned + trusted entries are skipped; floating ones are always re-copied', () => {
    const labels = { [mirrorLabelKey('curl')]: `curlimages/curl:8.10.1@${D1}`, [MIRROR_NODE_LABEL]: 'n1' };
    expect(planMirror(labels, 'n1', BOM).map((i) => i.key)).toEqual(['dns', 'registry']);
    expect(planMirror(labels, 'n2', BOM).map((i) => i.key)).toEqual(['curl', 'dns', 'registry']);
  });
  test('parse copier output', () => {
    const out = `noise\n${MIRROR_OK_MARKER} curl ${D1}\n${MIRROR_FAIL_MARKER} dns\n${MIRROR_OK_MARKER} bad notadigest\n`;
    const r = parseMirrorOutput(out);
    expect([...r.ok.entries()]).toEqual([['curl', D1]]);
    expect(r.failed).toEqual(['dns']);
  });
  test('a failed copy keeps the old label on the same node; a node change drops it', () => {
    const labels = { [mirrorLabelKey('dns')]: `ghcr.io/requestflo/swarmy-dns:latest@${D2}`, [MIRROR_NODE_LABEL]: 'n1' };
    const same = mirrorLabelsAfter(labels, 'n1', new Map([['curl', D1]]), BOM);
    expect(same.add[mirrorLabelKey('curl')]).toBe(`curlimages/curl:8.10.1@${D1}`);
    expect(same.removeKeys).toEqual([]);
    const moved = mirrorLabelsAfter(labels, 'n2', new Map(), BOM);
    expect(moved.removeKeys).toEqual([mirrorLabelKey('dns')]);
    expect(moved.add[MIRROR_NODE_LABEL]).toBe('n2');
  });
  test('a copy landing a digest other than the pin is rejected', () => {
    const r = mirrorLabelsAfter({}, 'n1', new Map([['curl', D2]]), BOM);
    expect(r.add[mirrorLabelKey('curl')]).toBeUndefined();
  });
});

describe('renderMirrorScript', () => {
  test('creds come from env, every item is attempted independently', () => {
    const s = renderMirrorScript([pinned, floating], H);
    expect(s).toContain('--pass-stdin');
    expect(s).not.toMatch(/-p\s+['"]?[A-Za-z0-9]/);
    expect(s).toContain(`regctl image copy 'docker.io/curlimages/curl@${D1}' 'localhost:5000/swarmy-system/docker.io/curlimages/curl:8.10.1'`);
    expect(s.split(MIRROR_FAIL_MARKER).length - 1).toBe(2);
  });
});
