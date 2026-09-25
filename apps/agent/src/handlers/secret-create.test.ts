import { describe, expect, it } from 'bun:test';
import { SECRET_CONTENT_LABEL, existingSecretMatches, secretContentHash, secretCreate } from './swarmres';

/** QA-026: "already exists" with the same content is success, not an endless retry. */
function fakeDocker(existing: Array<{ id: string; name: string; labels: Record<string, string> }>) {
  const created: Array<{ name: string; labels?: Record<string, string> }> = [];
  return {
    created,
    docker: {
      createSecret: async (name: string, _d: string, labels?: Record<string, string>) => {
        if (existing.some((s) => s.name === name)) {
          throw new Error('(HTTP code 409) unexpected - rpc error: code = AlreadyExists desc = secret swarmy-dns-admin already exists');
        }
        created.push({ name, labels });
        return 'new-id';
      },
      listSecrets: async () => existing.map((s) => ({ ...s, createdAt: 0 })),
    },
  };
}

const data = Buffer.from('tok', 'utf8').toString('base64');
const family = { 'swarmy.managed': 'true', 'swarmy.secret.family': 'dns-admin' };

describe('secretCreate', () => {
  it('stamps a content hash on create', async () => {
    const f = fakeDocker([]);
    expect(await secretCreate(f.docker, { commandId: 'c', name: 'x', dataB64: data, labels: family } as never)).toEqual({ id: 'new-id', name: 'x' });
    expect(f.created[0]!.labels?.[SECRET_CONTENT_LABEL]).toBe(secretContentHash(data));
  });

  it('409 with the same content hash → success (existed)', async () => {
    const f = fakeDocker([{ id: 's1', name: 'swarmy-dns-admin', labels: { ...family, [SECRET_CONTENT_LABEL]: secretContentHash(data) } }]);
    expect(await secretCreate(f.docker, { commandId: 'c', name: 'swarmy-dns-admin', dataB64: data, labels: family } as never)).toEqual({
      id: 's1',
      name: 'swarmy-dns-admin',
      existed: true,
    });
  });

  it('409 on a pre-hash secret carrying the same labels → success', async () => {
    const f = fakeDocker([{ id: 's1', name: 'swarmy-dns-admin', labels: family }]);
    expect((await secretCreate(f.docker, { commandId: 'c', name: 'swarmy-dns-admin', dataB64: data, labels: family } as never)).existed).toBe(true);
  });

  it('409 with different content still fails, clearly', async () => {
    const f = fakeDocker([{ id: 's1', name: 'swarmy-dns-admin', labels: { ...family, [SECRET_CONTENT_LABEL]: 'other' } }]);
    await expect(secretCreate(f.docker, { commandId: 'c', name: 'swarmy-dns-admin', dataB64: data, labels: family } as never)).rejects.toThrow(
      /already exists with different content/,
    );
  });

  it('existingSecretMatches never matches on no labels at all', () => {
    expect(existingSecretMatches({ labels: {} }, { hash: 'h' })).toBe(false);
  });
});
