import { describe, expect, it } from 'bun:test';
import { normalizeRef, selectContainersToRemove, selectHygieneImages, type RawContainer } from './hygiene';
import type { RawImage } from './prune';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const PROD = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const PREV = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

describe('selectContainersToRemove — only stopped one-shots', () => {
  const c = (over: Partial<RawContainer>): RawContainer => ({
    Id: over.Id ?? 'c',
    State: 'exited',
    Created: sec('2026-09-24T08:00:00Z'),
    Labels: {},
    restartPolicy: 'no',
    ...over,
  });
  it('removes old exited one-shots and keeps everything else', () => {
    const out = selectContainersToRemove(
      [
        c({ Id: 'oneshot' }),
        c({ Id: 'running', State: 'running' }),
        c({ Id: 'task', Labels: { 'com.docker.swarm.task.id': 't1' } }),
        c({ Id: 'stopped-by-user', restartPolicy: 'unless-stopped' }),
        c({ Id: 'always', restartPolicy: 'always' }),
        c({ Id: 'pinned', Labels: { 'swarmy.hygiene.keep': 'true' } }),
        c({ Id: 'fresh', Created: sec('2026-09-24T11:30:00Z') }),
        c({ Id: 'dead', State: 'dead' }),
      ],
      1,
      NOW,
    );
    expect(out.map((x) => x.Id)).toEqual(['oneshot', 'dead']);
  });
});

describe('selectHygieneImages — never an in-prod digest, never the previous release', () => {
  const img = (over: Partial<RawImage & { lastTagMs?: number }>): RawImage & { lastTagMs?: number } => ({
    Id: over.Id ?? 'sha256:x',
    RepoTags: [],
    RepoDigests: [],
    Created: sec('2026-08-01T00:00:00Z'),
    Size: 100,
    ...over,
  });
  const plan = (over: Partial<Parameters<typeof selectHygieneImages>[1]> = {}) => ({
    keepDigests: [],
    keepRefs: [],
    referencedIds: new Set<string>(),
    minAgeDays: 7,
    ...over,
  });

  it('keeps pinned digests (bare or repo@), keep refs, and container-referenced images', () => {
    const { remove, kept } = selectHygieneImages(
      [
        img({ Id: 'prod', RepoTags: ['localhost:5000/app:main'], RepoDigests: [`localhost:5000/app@${PROD}`] }),
        img({ Id: 'prev', RepoTags: ['localhost:5000/app:old'], RepoDigests: [`localhost:5000/app@${PREV}`] }),
        img({ Id: 'tagref', RepoTags: ['nginx:latest'] }),
        img({ Id: 'used', RepoTags: ['busybox:1'] }),
        img({ Id: 'stale', RepoTags: ['redis:6'] }),
      ],
      plan({ keepDigests: [PROD, `localhost:5000/app@${PREV}`], keepRefs: ['docker.io/library/nginx'], referencedIds: new Set(['used']) }),
      NOW,
    );
    expect(remove.map((i) => i.Id)).toEqual(['stale']);
    expect(kept).toBe(4);
  });

  it('removes unreferenced dangling images regardless of age; keeps recently pulled tagged ones', () => {
    const { remove } = selectHygieneImages(
      [
        img({ Id: 'dangling', Created: sec('2026-09-24T11:00:00Z') }),
        img({ Id: 'dangling-in-use', RepoTags: ['<none>:<none>'] }),
        img({ Id: 'old-build-new-pull', RepoTags: ['postgres:16'], lastTagMs: Date.parse('2026-09-23T00:00:00Z') }),
        img({ Id: 'new-build', RepoTags: ['app:2'], Created: sec('2026-09-22T00:00:00Z') }),
      ],
      plan({ referencedIds: new Set(['dangling-in-use']) }),
      NOW,
    );
    expect(remove.map((i) => i.Id)).toEqual(['dangling']);
  });

  it('a pinned digest is kept even when the image is dangling and ancient', () => {
    const { remove } = selectHygieneImages([img({ Id: PROD, RepoDigests: [`app@${PROD}`] })], plan({ keepDigests: [PROD] }), NOW);
    expect(remove).toEqual([]);
  });

  it('normalizeRef makes docker.io/library shorthands and implicit :latest compare equal', () => {
    expect(normalizeRef('nginx')).toBe('nginx:latest');
    expect(normalizeRef('docker.io/library/nginx:1.27')).toBe('nginx:1.27');
    expect(normalizeRef('localhost:5000/app')).toBe('localhost:5000/app:latest');
    expect(normalizeRef(`localhost:5000/app:main@${PROD}`)).toBe('localhost:5000/app:main');
  });
});
