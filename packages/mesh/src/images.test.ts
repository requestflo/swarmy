import { describe, expect, it } from 'bun:test';
import { SYSTEM_IMAGES } from '@swarmy/core/system-images';
import { HeadscaleDriver } from './drivers/headscale';
import { NetbirdDriver } from './drivers/netbird';
import {
  LITESTREAM_IMAGE_PINNED,
  NETBIRD_CLIENT_IMAGE_PINNED,
  NETBIRD_SERVER_IMAGE,
  NETBIRD_VERSION,
  TAILSCALE_CLIENT_IMAGE_PINNED,
} from './images';

const DIGEST = /@sha256:[a-f0-9]{64}$/;
const bom = (key: string) => SYSTEM_IMAGES.find((i) => i.key === key)!;
const config = { driver: 'netbird', enabled: true, managementUrl: 'https://mesh.example.com', controlPlane: {}, settings: {} } as never;
const enrollment = { driver: 'netbird', managementUrl: 'https://mesh.example.com', setupKey: 'k', authKey: 'k', advertiseRoutes: [], acceptRoutes: true } as never;

describe('mesh images come from the SYSTEM_IMAGES BOM, by digest', () => {
  it('every mesh image is `ref@digest` straight from the BOM, never a floating tag', () => {
    for (const [img, key] of [
      [NETBIRD_SERVER_IMAGE, 'netbirdServer'],
      [NETBIRD_CLIENT_IMAGE_PINNED, 'netbirdClient'],
      [TAILSCALE_CLIENT_IMAGE_PINNED, 'tailscaleClient'],
      [LITESTREAM_IMAGE_PINNED, 'litestream'],
    ] as const) {
      expect(img).toBe(`${bom(key).ref}@${bom(key).digest}`);
      expect(img).toMatch(DIGEST);
      expect(img).not.toContain(':latest');
    }
  });

  it('the NetBird control plane and clients run the same release (the server upgrades first)', () => {
    expect(NETBIRD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bom('netbirdServer').ref.endsWith(`:${NETBIRD_VERSION}`)).toBe(true);
    expect(bom('netbirdClient').ref.endsWith(`:${NETBIRD_VERSION}`)).toBe(true);
  });

  it('both drivers render the pinned client by default', () => {
    expect(new NetbirdDriver().render(config, enrollment).client?.image).toBe(NETBIRD_CLIENT_IMAGE_PINNED);
    expect(new HeadscaleDriver().render(config, { ...(enrollment as object), driver: 'headscale' } as never).client?.image).toBe(
      TAILSCALE_CLIENT_IMAGE_PINNED,
    );
  });
});
