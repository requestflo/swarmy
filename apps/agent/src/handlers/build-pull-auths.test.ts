import { describe, expect, it } from 'bun:test';
import type { BuildImagePayload } from '@swarmy/core/protocol';
import { renderBuildProgram, renderDockerConfig } from './build';

function payload(over: Partial<BuildImagePayload> = {}): BuildImagePayload {
  return {
    commandId: '11111111-2222-3333-4444-555555555555',
    source: { url: 'https://github.com/acme/app', ref: 'main' },
    imageRefs: ['localhost:5000/app:main'],
    pushPolicy: 'always',
    ...over,
  } as BuildImagePayload;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('renderDockerConfig (build pullAuths)', () => {
  it('no auth at all → empty (no config written)', () => {
    expect(renderDockerConfig(payload(), 'localhost:5000/app:main')).toBe('');
    expect(renderBuildProgram(payload())).not.toContain('config.json');
  });

  it('merges third-party pull logins with the push login, keyed by server (golden)', () => {
    const cfg = renderDockerConfig(
      payload({
        registryAuth: { username: 'swarmy', password: 'push', server: 'localhost:5000' },
        pullAuths: [
          { username: 'me', password: 'ghp_x', server: 'ghcr.io' },
          { username: 'hub', password: 'dckr', server: 'https://index.docker.io/v1/' },
        ],
      }),
      'localhost:5000/app:main',
    );
    expect(JSON.parse(cfg)).toEqual({
      auths: {
        'ghcr.io': { auth: b64('me:ghp_x') },
        'https://index.docker.io/v1/': { auth: b64('hub:dckr') },
        'localhost:5000': { auth: b64('swarmy:push') },
      },
    });
  });

  it('the push login wins a server collision; push without server falls back to the ref host', () => {
    const cfg = renderDockerConfig(
      payload({
        registryAuth: { username: 'swarmy', password: 'push' },
        pullAuths: [{ username: 'other', password: 'x', server: 'localhost:5000' }],
      }),
      'localhost:5000/app:main',
    );
    expect(JSON.parse(cfg).auths['localhost:5000']).toEqual({ auth: b64('swarmy:push') });
  });

  it('pull-only (pushPolicy never) still writes the config for FROM bases', () => {
    const prog = renderBuildProgram(
      payload({ pushPolicy: 'never', pullAuths: [{ username: 'me', password: 'tok', server: 'ghcr.io' }] }),
    );
    expect(prog).toContain('> "$DOCKER_CONFIG/config.json"');
  });
});
