import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeImagePath, nodeImagesApp } from './node-images';

const FILE = `sha256-${'a'.repeat(64)}-linux-amd64.tar`;

describe('/install/images (node bootstrap image archives)', () => {
  it('serves only archives built into this controller, by exact digest name', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-node-images-'));
    try {
      writeFileSync(path.join(dir, FILE), 'tar-bytes');
      writeFileSync(path.join(dir, 'secret.txt'), 'nope');
      const app = nodeImagesApp(() => dir);
      const ok = await app.request(`/install/images/${FILE}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('tar-bytes');
      expect(ok.headers.get('cache-control')).toContain('immutable');
      expect((await app.request(`/install/images/sha256-${'b'.repeat(64)}-linux-amd64.tar`)).status).toBe(404);
      expect((await app.request('/install/images/secret.txt')).status).toBe(404);
      expect((await app.request('/install/images/..%2Fsecret.txt')).status).toBe(404);
      expect(nodeImagePath(`../${FILE}`, dir)).toBeNull();
      expect(nodeImagePath(`sha256-${'a'.repeat(64)}-linux-riscv64.tar`, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
