import { describe, expect, it } from 'bun:test';
import { DeployServicePayload } from './commands';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';
import { PROTOCOL_VERSION } from './constants';

const CMD_ID = '00000000-0000-4000-8000-000000000003';

/**
 * `deployService.registryAuth` (additive): the pull credentials the swarm stores
 * with the service so every node can pull an org-registry image.
 */
describe('DeployServicePayload.registryAuth round-trip', () => {
  const spec = { name: 'web', image: 'localhost:5000/acme-web@sha256:' + 'a'.repeat(64) };
  const registryAuth = { username: 'swarmy', password: 's3cret', server: 'localhost:5000' };

  it('survives JSON → envelope parse unchanged', () => {
    const wire = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: '00000000-0000-4000-8000-00000000000a',
      ts: Date.now(),
      type: 'deployService',
      payload: { commandId: CMD_ID, spec, pullPolicy: 'always', registryAuth },
    });
    const env = parseControllerEnvelope(JSON.parse(wire));
    expect(env).not.toBeNull();
    if (!env || env.type !== 'deployService') throw new Error('wrong type');
    expect(env.payload.registryAuth).toEqual(registryAuth);
    expect(env.payload.spec).toMatchObject(spec);
  });

  it('is optional (older controllers / public images carry none)', () => {
    const parsed = ControllerToAgentMessage.parse({ type: 'deployService', payload: { commandId: CMD_ID, spec } });
    if (parsed.type !== 'deployService') throw new Error('wrong type');
    expect(parsed.payload.registryAuth).toBeUndefined();
  });

  it('rejects a malformed auth (password missing)', () => {
    expect(
      DeployServicePayload.safeParse({ commandId: CMD_ID, spec, registryAuth: { username: 'swarmy' } }).success,
    ).toBe(false);
  });
});
