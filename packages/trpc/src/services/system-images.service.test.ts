import { describe, expect, test } from 'bun:test';
import { MIRROR_NODE_LABEL, mirrorLabelKey, systemImage } from '@swarmy/core/system-images';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { attachRegistryAuth, dispatchImages, registryServiceSpec } from './registry-auth';
import {
  REGISTRY_CACHE_PORT,
  mirrorStateFrom,
  registryCacheServiceSpec,
  rewriteSystemImages,
  type MirrorState,
} from './system-images.service';

const H = 'localhost:5000';
const curl = systemImage('curl');
const buildkit = systemImage('buildkit');
const labels = {
  [mirrorLabelKey('curl')]: `${curl.ref}@${curl.digest}`,
  [mirrorLabelKey('buildkit')]: `${buildkit.ref}@${buildkit.digest}`,
  [MIRROR_NODE_LABEL]: 'swarm-n1',
};
const state: MirrorState = { labels, registryNodeId: 'swarm-n1', registry: undefined };
const CURL_MIRROR = `localhost:5000/swarmy-system/docker.io/curlimages/curl@${curl.digest}`;

function svc(over: Partial<SwarmServiceInfo>): SwarmServiceInfo {
  return {
    id: 'sid',
    name: 'swarmy-registry',
    image: 'registry:2',
    mode: 'replicated',
    runningReplicas: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    labels: {},
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
    ...over,
  } as SwarmServiceInfo;
}

describe('mirrorStateFrom', () => {
  test('reads the registry labels and the node its running task is on', () => {
    const s = mirrorStateFrom({
      services: [svc({ labels })],
      containers: [
        { state: 'exited', serviceId: 'sid', labels: { 'com.docker.swarm.node.id': 'old' } },
        { state: 'running', serviceId: 'sid', labels: { 'com.docker.swarm.node.id': 'swarm-n1' } },
      ],
    });
    expect(s.registryNodeId).toBe('swarm-n1');
    expect(s.labels).toEqual(labels);
  });
  test('no registry / no running task → no node', () => {
    expect(mirrorStateFrom({ services: [], containers: [] }).registryNodeId).toBeNull();
    expect(mirrorStateFrom({ services: [svc({})], containers: [] }).registryNodeId).toBeNull();
  });
});

describe('rewriteSystemImages', () => {
  test('service.deploy of an exact system ref deploys the mirrored digest', () => {
    const p = { spec: { name: 'x', image: curl.ref } };
    expect(rewriteSystemImages('service.deploy', p, H, state)).toEqual({ spec: { name: 'x', image: CURL_MIRROR } });
  });
  test('runOnce keeps the upstream ref as the agent-side fallback', () => {
    expect(rewriteSystemImages<Record<string, unknown>>('container.runOnce', { image: curl.ref }, H, state)).toEqual({
      image: CURL_MIRROR,
      fallbackImage: curl.ref,
    });
  });
  test('a build without an explicit builder image gets the mirrored BuildKit', () => {
    const out = rewriteSystemImages('image.build', { imageRefs: ['a'] }, H, state) as { builderImage?: string };
    expect(out.builderImage).toBe(`localhost:5000/swarmy-system/docker.io/moby/buildkit@${buildkit.digest}`);
    const explicit = { imageRefs: ['a'], builderImage: 'my/buildkit:1' };
    expect(rewriteSystemImages('image.build', explicit, H, state)).toBe(explicit);
  });
  test('user images, unmirrored refs, other commands and a moved registry are untouched (same reference)', () => {
    const user = { spec: { name: 'x', image: 'nginx:1' } };
    expect(rewriteSystemImages('service.deploy', user, H, state)).toBe(user);
    const trivy = { image: systemImage('trivy').ref };
    expect(rewriteSystemImages('container.runOnce', trivy, H, state)).toBe(trivy);
    const moved = { ...state, registryNodeId: 'swarm-n2' };
    const p = { image: curl.ref };
    expect(rewriteSystemImages('container.runOnce', p, H, moved)).toBe(p);
    expect(rewriteSystemImages('service.remove', p, H, state)).toBe(p);
  });
  test('the registry itself is never rewritten to depend on itself', () => {
    const reg = systemImage('registry');
    const withReg = { ...state, labels: { ...labels, [mirrorLabelKey('registry')]: `${reg.ref}@${reg.digest}` } };
    const p = { spec: { name: 'swarmy-registry', image: reg.ref } };
    expect(rewriteSystemImages('service.deploy', p, H, withReg)).toBe(p);
  });
});

describe('pull auth for mirrored runOnce images', () => {
  test('runOnce pulls count as pulls, so a mirrored ref gets the registry login', () => {
    expect(dispatchImages('container.runOnce', { image: CURL_MIRROR })).toEqual([CURL_MIRROR]);
    const out = attachRegistryAuth('container.runOnce', { image: CURL_MIRROR }, H, { username: 'swarmy', password: 'pw' });
    expect(out).toMatchObject({ registryAuth: { username: 'swarmy', password: 'pw', server: H } });
  });
});

describe('specs', () => {
  test('a registry redeploy carries the mirror labels, auth labels win', () => {
    const s = registryServiceSpec('sec', { ...labels, 'swarmy.registry.auth': 'spoof' });
    expect(s.labels?.[MIRROR_NODE_LABEL]).toBe('swarm-n1');
    expect(s.labels?.['swarmy.registry.auth']).toBe('sec');
  });
  test('the pull-through cache proxies Docker Hub on :5001, overridable upstream', () => {
    const s = registryCacheServiceSpec();
    expect(s.env).toMatchObject({ REGISTRY_PROXY_REMOTEURL: 'https://registry-1.docker.io' });
    expect(s.ports?.[0]).toMatchObject({ target: 5000, published: REGISTRY_CACHE_PORT, mode: 'ingress' });
    expect(registryCacheServiceSpec('https://hub-mirror.corp').env?.REGISTRY_PROXY_REMOTEURL).toBe('https://hub-mirror.corp');
  });
});
