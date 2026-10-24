import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { overlayDriverOptions } from '@swarmy/core';

/**
 * The installer creates swarmy / swarmy-control / swarmy-integrations with
 * `overlay_mtu`; it must agree with overlayMtuFor() (the option is the tunnel
 * MTU itself: Docker subtracts VXLAN + ESP), or the platform overlays and the
 * app overlays that inherit their option would be sized differently.
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

function overlayMtu(env: Record<string, string>): string {
  const r = Bun.spawnSync(['bash', '-c', '. "$0"; NB_INTERFACE=swarmy-no-such-if0; overlay_mtu || true', SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return r.stdout.toString();
}

describe('installer overlay_mtu', () => {
  it('a mesh install without wt0 yet → 1280, the same option the controller gives new overlays', () => {
    expect(overlayMtu({ SWARMY_MESH: 'swarmy' })).toBe('1280');
    expect(overlayDriverOptions({ meshDriver: 'netbird', meshEnabled: true, encrypted: true })?.['com.docker.network.driver.mtu']).toBe('1280');
  });
  it('no mesh → no option (Docker default)', () => {
    expect(overlayMtu({ SWARMY_MESH: 'none' })).toBe('');
  });
});
