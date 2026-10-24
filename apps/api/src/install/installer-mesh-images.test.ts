import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { pinnedTaggedRef } from '@swarmy/core/system-images';

/**
 * The installer starts NetBird (client and, with --mesh swarmy, the control
 * plane) before any controller exists, so it carries its own image defaults.
 * They must be the SYSTEM_IMAGES pins, digest and all: a BOM bump that forgets
 * the installer would start node #1 on a different release than every node the
 * controller enrolls afterwards.
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

function installerVar(name: string): string {
  const env = { ...process.env };
  delete env.SWARMY_NETBIRD_IMAGE;
  delete env.SWARMY_NETBIRD_SERVER_IMAGE;
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; printf '%s' "$${name}"`, SCRIPT], { stdout: 'pipe', stderr: 'pipe', env });
  return r.stdout.toString();
}

describe('installer mesh images = the BOM pins', () => {
  it('the NetBird client', () => {
    expect(installerVar('NETBIRD_IMAGE')).toBe(pinnedTaggedRef('netbirdClient'));
  });
  it('the NetBird control plane', () => {
    expect(installerVar('MESH_CONTROL_IMAGE')).toBe(pinnedTaggedRef('netbirdServer'));
  });
});
