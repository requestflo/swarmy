import { describe, expect, it } from 'bun:test';
import { ServiceStatePayload } from './containers';
import { ControllerToAgentMessage } from './messages';
import { isSwarmyStackNetwork } from '../inventory';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

describe('removeStackNetworks', () => {
  it('joins the controller→agent union', () => {
    const r = ControllerToAgentMessage.safeParse({
      type: 'removeStackNetworks',
      payload: { commandId: CMD_ID, stack: 'site' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty stack name (would match nothing sane)', () => {
    const r = ControllerToAgentMessage.safeParse({
      type: 'removeStackNetworks',
      payload: { commandId: CMD_ID, stack: '' },
    });
    expect(r.success).toBe(false);
  });
});

describe('isSwarmyStackNetwork — only swarmy-created overlays of THAT stack', () => {
  const managed = (stack: string) => ({ 'com.docker.stack.namespace': stack, 'swarmy.managed': 'true' });

  it('matches <stack>_default / <stack>_<net> that swarmy created', () => {
    expect(isSwarmyStackNetwork({ Name: 'site_default', Labels: managed('site') }, 'site')).toBe(true);
    expect(isSwarmyStackNetwork({ Name: 'site_backend', Labels: managed('site') }, 'site')).toBe(true);
  });

  it('never matches another stack, an unlabelled/external network, or a docker stack deploy network', () => {
    expect(isSwarmyStackNetwork({ Name: 'other_default', Labels: managed('other') }, 'site')).toBe(false);
    expect(isSwarmyStackNetwork({ Name: 'site_shared', Labels: {} }, 'site')).toBe(false);
    expect(isSwarmyStackNetwork({ Name: 'site_ext', Labels: null }, 'site')).toBe(false);
    // `docker stack deploy` stamps the namespace but not swarmy.managed.
    expect(
      isSwarmyStackNetwork({ Name: 'site_default', Labels: { 'com.docker.stack.namespace': 'site' } }, 'site'),
    ).toBe(false);
  });

  it('never matches the shared swarmy overlay or docker system networks, whatever their labels', () => {
    expect(isSwarmyStackNetwork({ Name: 'swarmy', Labels: managed('site') }, 'site')).toBe(false);
    expect(isSwarmyStackNetwork({ Name: 'ingress', Labels: managed('site') }, 'site')).toBe(false);
  });
});

describe('SwarmServiceInfo.taskHealth', () => {
  const base = {
    id: 's1',
    name: 'web',
    image: 'img:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 0,
    createdAt: 0,
    updatedAt: 0,
    labels: {},
  };
  it('is optional (older agent = unknown, not "healthy")', () => {
    const r = ServiceStatePayload.parse({ snapshotAt: 0, isManager: true, services: [base] });
    expect(r.services[0]!.taskHealth).toBeUndefined();
  });
  it('round-trips a crash-loop summary', () => {
    const th = { recentFailures: 3, lastError: 'task: non-zero exit (1)', lastErrorAt: 1_000, starting: false };
    const r = ServiceStatePayload.parse({ snapshotAt: 0, isManager: true, services: [{ ...base, taskHealth: th }] });
    expect(r.services[0]!.taskHealth).toEqual(th);
  });
});
