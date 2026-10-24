// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Node bootstrap images, served by this controller like the agent binaries:
 * the per-architecture `docker load` archives a NEW node needs before it can
 * reach the cluster's registry — the NetBird client for its first mesh join
 * (the swarm, and so the registry forwarder, only come after the mesh) and
 * the forwarder's Caddy (`@swarmy/core/image-archive`). Built into the image
 * by `scripts/fetch-node-images.ts` (Dockerfile stage `nodeimages`).
 *
 *   GET /install/images/sha256-<index hex>-linux-<amd64|arm64>.tar
 *
 * Named by the pinned index digest, so an agent asks for exactly the image
 * its own ref pins, and checks every byte against that digest before
 * `docker load` (apps/agent/src/handlers/controller-image.ts). That makes the
 * archives verified blobs: the H17 transport policy (./transport.ts) serves
 * them over plain HTTP too, like /install/bin.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';

export const NODE_IMAGE_FILE_RE = /^sha256-[a-f0-9]{64}-linux-(amd64|arm64)\.tar$/;

export function nodeImagesDir(env: Record<string, string | undefined> = process.env): string {
  return env.SWARMY_NODE_IMAGES_DIR?.trim() || path.resolve(process.cwd(), 'node-images');
}

/** The archive on disk for `file`, or null (bad name, or not built into this controller). */
export function nodeImagePath(file: string, dir: string = nodeImagesDir()): string | null {
  if (!NODE_IMAGE_FILE_RE.test(file)) return null;
  const p = path.join(dir, file);
  return existsSync(p) ? p : null;
}

export function nodeImagesApp(dir?: () => string): Hono {
  const app = new Hono();
  app.get('/install/images/:file{[a-z0-9.-]+}', (c) => {
    const file = c.req.param('file');
    const p = nodeImagePath(file, dir?.());
    if (!p) return c.text(`no node image ${file} on this controller`, 404);
    return new Response(Bun.file(p), {
      headers: {
        'content-type': 'application/x-tar',
        'content-disposition': `attachment; filename="${file}"`,
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  });
  return app;
}
