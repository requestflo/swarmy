import { describe, expect, it } from 'bun:test';
import { BuildImagePayload } from './build';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';
import { PROTOCOL_VERSION } from './constants';

const CMD_ID = '00000000-0000-4000-8000-000000000004';

/** `buildImage.pullAuths` (additive): third-party logins for private FROM bases. */
describe('BuildImagePayload.pullAuths round-trip', () => {
  const base = {
    commandId: CMD_ID,
    source: { url: 'https://github.com/acme/app', ref: 'main' },
    imageRefs: ['localhost:5000/app:main'],
  };
  const pullAuths = [
    { username: 'me', password: 'ghp_x', server: 'ghcr.io' },
    { username: 'hub', password: 'dckr', server: 'https://index.docker.io/v1/' },
  ];

  it('survives JSON → envelope parse unchanged', () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: '00000000-0000-4000-8000-00000000000b',
      ts: Date.now(),
      type: 'buildImage',
      payload: { ...base, pullAuths },
    });
    const env = parseControllerEnvelope(JSON.parse(wire));
    if (!env || env.type !== 'buildImage') throw new Error('wrong type');
    expect(env.payload.pullAuths).toEqual(pullAuths);
  });

  it('is optional (older controllers carry none)', () => {
    const parsed = ControllerToAgentMessage.parse({ type: 'buildImage', payload: base });
    if (parsed.type !== 'buildImage') throw new Error('wrong type');
    expect(parsed.payload.pullAuths).toBeUndefined();
  });

  it('rejects a malformed entry', () => {
    expect(BuildImagePayload.safeParse({ ...base, pullAuths: [{ username: 'x' }] }).success).toBe(false);
  });
});
