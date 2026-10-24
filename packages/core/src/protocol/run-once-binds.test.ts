import { describe, expect, it } from 'bun:test';
import { mirrorRepoFor, systemImage } from '../system-images';
import { DEFAULT_RESTIC_IMAGE } from './backup';
import { hostRepoPathRefusal, imageRepoOf, runOnceBindRefusal, runOnceBindsRefusal } from './run-once-binds';

const DOCKER_CLI = systemImage('dockerCli').ref;
const MIRRORED_CLI = `${mirrorRepoFor(DOCKER_CLI, '10.0.0.5:5000')}@sha256:${'a'.repeat(64)}`;
const SOCK = '/var/run/docker.sock:/var/run/docker.sock';

describe('imageRepoOf', () => {
  it('normalises Hub shorthands and unwraps a swarmy-system mirror copy', () => {
    expect(imageRepoOf('docker:27.5-cli')).toBe('docker.io/library/docker');
    expect(imageRepoOf('docker.io/library/docker:27.5-cli')).toBe('docker.io/library/docker');
    expect(imageRepoOf(MIRRORED_CLI)).toBe('docker.io/library/docker');
    expect(imageRepoOf(DEFAULT_RESTIC_IMAGE)).toBe('docker.io/restic/restic');
  });
});

describe('runOnce bind allowlist: what swarmy itself mounts', () => {
  it('named volumes at safe container paths, read-only or not', () => {
    for (const b of ['swarmy-registry-data:/var/lib/registry:ro', 'garage-meta:/src:ro', 'pg_data:/var/lib/postgresql', 'app.v1:/v/app.v1:ro', 'trivy-cache:/root/.cache/trivy:rw']) {
      expect(runOnceBindRefusal(b, ['alpine:3.20'])).toBeNull();
    }
  });

  it('the Docker socket for the docker CLI system image (upstream or mirrored)', () => {
    expect(runOnceBindRefusal(SOCK, [DOCKER_CLI])).toBeNull();
    expect(runOnceBindRefusal(SOCK, [MIRRORED_CLI, DOCKER_CLI])).toBeNull();
  });

  it('a node restic repo, identity-mapped, for the restic image', () => {
    expect(runOnceBindRefusal('/srv/backups/acme:/srv/backups/acme', [DEFAULT_RESTIC_IMAGE])).toBeNull();
    expect(runOnceBindRefusal('/home/ops/restic:/home/ops/restic', [DEFAULT_RESTIC_IMAGE])).toBeNull();
  });

  it('no binds at all is fine', () => {
    expect(runOnceBindsRefusal(undefined, ['alpine'])).toBeNull();
    expect(runOnceBindsRefusal([], ['alpine'])).toBeNull();
  });
});

describe('runOnce bind allowlist: everything else is refused', () => {
  it('host root and system paths, whatever the image', () => {
    expect(runOnceBindRefusal('/:/host', ['alpine'])).toContain('same path');
    expect(runOnceBindRefusal('/:/', [DEFAULT_RESTIC_IMAGE])).toContain('plain absolute path');
    for (const p of ['/etc', '/etc/swarmy', '/root', '/var/lib/docker/volumes', '/var/lib/swarmy', '/proc/1', '/run/secrets']) {
      expect(runOnceBindRefusal(`${p}:${p}`, [DEFAULT_RESTIC_IMAGE])).toContain('system path');
    }
  });

  it('the Docker socket for any other image, or remapped', () => {
    expect(runOnceBindRefusal(SOCK, ['alpine:3.20'])).toContain('docker CLI');
    expect(runOnceBindRefusal(SOCK, [])).toContain('docker CLI');
    // A docker-CLI image with a non-CLI fallback: the agent may run either, so both must qualify.
    expect(runOnceBindRefusal(SOCK, [DOCKER_CLI, 'alpine'])).toContain('docker CLI');
    expect(runOnceBindRefusal('/var/run/docker.sock:/sock', [DOCKER_CLI])).toContain('its own path');
    expect(runOnceBindRefusal('/run/docker.sock:/run/docker.sock', [DOCKER_CLI])).not.toBeNull();
  });

  it('a host path for a non-restic image, or mapped somewhere else', () => {
    expect(runOnceBindRefusal('/srv/backups:/srv/backups', ['alpine'])).toContain('restic');
    expect(runOnceBindRefusal('/srv/backups:/data', [DEFAULT_RESTIC_IMAGE])).toContain('same path');
  });

  it('bad shapes: options, traversal, odd modes', () => {
    expect(runOnceBindRefusal('vol:/data:ro,z', ['alpine'])).toContain('mode');
    expect(runOnceBindRefusal('vol:/data:ro:extra', ['alpine'])).toContain('source:target');
    expect(runOnceBindRefusal('vol', ['alpine'])).toContain('source:target');
    expect(runOnceBindRefusal('vol:/a/../etc', ['alpine'])).toContain('container path');
    expect(runOnceBindRefusal('vol:relative', ['alpine'])).toContain('container path');
    expect(runOnceBindRefusal('-vol:/data', ['alpine'])).toContain('volume name');
    expect(runOnceBindRefusal('/srv/../etc:/srv/../etc', [DEFAULT_RESTIC_IMAGE])).not.toBeNull();
  });

  it('one bad bind refuses the whole one-shot', () => {
    expect(runOnceBindsRefusal(['vol:/data', '/:/host'], ['alpine', undefined])).not.toBeNull();
  });
});

describe('hostRepoPathRefusal', () => {
  it('accepts plain non-system paths and refuses trailing slashes, dot segments and doubled slashes', () => {
    expect(hostRepoPathRefusal('/mnt/backups')).toBeNull();
    for (const p of ['/', '/mnt/', '/mnt/.', '/mnt/./x', '/mnt//x', 'mnt/x']) expect(hostRepoPathRefusal(p)).not.toBeNull();
  });
});
