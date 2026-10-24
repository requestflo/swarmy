import { describe, expect, test } from 'bun:test';
import { MIRROR_NODE_LABEL, mirrorLabelKey, pinnedTaggedRef, systemImage } from '@swarmy/core/system-images';
import { attachRegistryAuth, dispatchImages } from './registry-auth';
import { bareSystemRef, rewriteSystemImages, type MirrorState } from './system-images.service';

/** M3 client mirror: mesh clients get a `mirrorImage` hint, never a rewritten image. */
const H = 'localhost:5000';
const nb = systemImage('netbirdClient');
const ts = systemImage('tailscaleClient');
const PINNED = pinnedTaggedRef('netbirdClient');
const NB_MIRROR = `localhost:5000/swarmy-system/ghcr.io/netbirdio/netbird@${nb.digest}`;
const state: MirrorState = {
  labels: {
    [mirrorLabelKey('netbirdClient')]: `${nb.ref}@${nb.digest}`,
    [mirrorLabelKey('tailscaleClient')]: `${ts.ref}@${ts.digest}`,
    [MIRROR_NODE_LABEL]: 'swarm-n1',
  },
  registryNodeId: 'swarm-n1',
  registry: undefined,
};
const applyMesh = (image: string) => ({ rendered: { driver: 'netbird', client: { kind: 'netbird', image } } });

describe('mesh client image hints', () => {
  test('bareSystemRef: a pinned BOM ref → the bare ref; another digest or image → null', () => {
    expect(bareSystemRef(PINNED)).toBe(nb.ref);
    expect(bareSystemRef(nb.ref)).toBe(nb.ref);
    expect(bareSystemRef(`${nb.ref}@sha256:${'0'.repeat(64)}`)).toBeNull();
    expect(bareSystemRef('nginx:1')).toBeNull();
    expect(bareSystemRef(undefined)).toBeNull();
  });

  test('applyMesh keeps the upstream image and gains the cluster copy as a hint', () => {
    const out = rewriteSystemImages('applyMesh', applyMesh(PINNED), H, state) as ReturnType<typeof applyMesh> & { mirrorImage?: string };
    expect(out.rendered.client.image).toBe(PINNED);
    expect(out.mirrorImage).toBe(NB_MIRROR);
  });

  test('access routers get the same hint; Headscale’s tailscale client too', () => {
    const r = rewriteSystemImages<Record<string, unknown>>('mesh.accessRouter', { stackId: 's', network: 'n', image: PINNED }, H, state);
    expect(r).toMatchObject({ image: PINNED, mirrorImage: NB_MIRROR });
    const t = rewriteSystemImages('applyMesh', applyMesh(pinnedTaggedRef('tailscaleClient')), H, state) as { mirrorImage?: string };
    expect(t.mirrorImage).toBe(`localhost:5000/swarmy-system/docker.io/tailscale/tailscale@${ts.digest}`);
    // The upgrade's mesh step re-images the client the same way.
    const re = rewriteSystemImages<Record<string, unknown>>('mesh.reimage', { image: PINNED }, H, state);
    expect(re).toMatchObject({ image: PINNED, mirrorImage: NB_MIRROR });
    expect(dispatchImages('mesh.reimage', re)).toEqual([NB_MIRROR]);
  });

  test('no trusted copy, a custom client image or an explicit hint → payload untouched (same reference)', () => {
    const p = applyMesh(PINNED);
    expect(rewriteSystemImages('applyMesh', p, H, { ...state, registryNodeId: 'swarm-n2' })).toBe(p);
    const custom = applyMesh('my/netbird:fork');
    expect(rewriteSystemImages('applyMesh', custom, H, state)).toBe(custom);
    const hinted = { ...applyMesh(PINNED), mirrorImage: 'x' };
    expect(rewriteSystemImages('applyMesh', hinted, H, state)).toBe(hinted);
  });

  test('only the hint needs the registry login: the public upstream ref never does', () => {
    expect(dispatchImages('applyMesh', applyMesh(PINNED))).toEqual([]);
    expect(dispatchImages('mesh.accessRouter', { image: PINNED, mirrorImage: NB_MIRROR })).toEqual([NB_MIRROR]);
    const out = attachRegistryAuth('applyMesh', { ...applyMesh(PINNED), mirrorImage: NB_MIRROR }, H, { username: 'swarmy', password: 'pw' });
    expect(out).toMatchObject({ registryAuth: { username: 'swarmy', password: 'pw', server: H } });
  });
});
