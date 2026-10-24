import { describe, expect, it } from 'bun:test';
import { NodeFacts, RegisterMsg } from './protocol';
import {
  REGISTRY_FORWARDER_NETWORK,
  forwarderStartIssue,
  registryForwarderContainer,
  registryForwarderImage,
  renderForwarderCaddyfile,
} from './registry-forwarder';

describe('registryForwarderContainer (M16: loopback-only, on the encrypted overlay)', () => {
  const c = registryForwarderContainer('caddy:2-alpine@sha256:abc');

  it('publishes :5000/:5001 on 127.0.0.1 only, never on every interface', () => {
    expect(c.HostConfig.PortBindings).toEqual({
      '5000/tcp': [{ HostIp: '127.0.0.1', HostPort: '5000' }],
      '5001/tcp': [{ HostIp: '127.0.0.1', HostPort: '5001' }],
    });
    for (const b of Object.values(c.HostConfig.PortBindings).flat()) expect(b.HostIp).toBe('127.0.0.1');
  });

  it('joins the swarmy overlay (not host, not ingress) and comes back with dockerd', () => {
    expect(REGISTRY_FORWARDER_NETWORK).toBe('swarmy');
    expect(c.HostConfig.NetworkMode).toBe('swarmy');
    expect(c.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
  });

  it('runs with no privileges beyond binding a port, on a read-only root', () => {
    expect(c.HostConfig.CapDrop).toEqual(['ALL']);
    expect(c.HostConfig.CapAdd).toEqual(['NET_BIND_SERVICE']);
    expect(c.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    expect(c.HostConfig.ReadonlyRootfs).toBe(true);
  });

  it('defaults to the BOM-pinned Caddy, by digest', () => {
    expect(registryForwarderImage()).toMatch(/^caddy:2-alpine@sha256:[a-f0-9]{64}$/);
    expect(registryForwarderContainer().Image).toBe(registryForwarderImage());
  });

  it('is deterministic (the agent hashes it into the spec label)', () => {
    expect(JSON.stringify(registryForwarderContainer('x'))).toBe(JSON.stringify(registryForwarderContainer('x')));
  });
});

describe('renderForwarderCaddyfile', () => {
  it('proxies each port to its swarm service over the overlay, no admin API or ACME', () => {
    expect(renderForwarderCaddyfile()).toBe(
      '{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n}\n' +
        'http://:5000 {\n\treverse_proxy swarmy-registry:5000 {\n\t\tflush_interval -1\n\t}\n}\n' +
        'http://:5001 {\n\treverse_proxy swarmy-registry-cache:5000 {\n\t\tflush_interval -1\n\t}\n}\n',
    );
  });
});

describe('forwarderStartIssue', () => {
  it('names the start failures an operator can act on', () => {
    expect(forwarderStartIssue('driver failed programming external connectivity: Bind for 127.0.0.1:5000 failed: port is already allocated')).toBe('port-held');
    expect(forwarderStartIssue('listen tcp4 127.0.0.1:5000: bind: address already in use')).toBe('port-held');
    expect(forwarderStartIssue('Could not attach to network swarmy: rpc error: network swarmy not manually attachable')).toBe('not-attachable');
    expect(forwarderStartIssue('network swarmy not found')).toBe('no-network');
    expect(forwarderStartIssue('boom')).toBe('other');
  });
});

describe('NodeFacts.registryForwarder (additive)', () => {
  const facts = {
    hostname: 'n1',
    os: 'linux',
    arch: 'x64',
    cpuCount: 2,
    memTotalBytes: 1,
    dockerVersion: '27',
    swarmRole: 'manager',
    agentVersion: '1.0.0',
    protocolVersions: [1],
  };

  it('is optional: an older agent without it still parses', () => {
    const r = NodeFacts.safeParse(facts);
    expect(r.success).toBe(true);
    expect(r.success && r.data.registryForwarder).toBeUndefined();
  });

  it('accepts on/off and rejects anything else', () => {
    expect(NodeFacts.safeParse({ ...facts, registryForwarder: 'on' }).success).toBe(true);
    expect(NodeFacts.safeParse({ ...facts, registryForwarder: 'off' }).success).toBe(true);
    expect(NodeFacts.safeParse({ ...facts, registryForwarder: true }).success).toBe(false);
  });

  it('rides the register message', () => {
    const msg = { type: 'register', payload: { auth: { kind: 'join', joinToken: 't' }, facts: { ...facts, registryForwarder: 'on' } } };
    expect(RegisterMsg.safeParse(msg).success).toBe(true);
    expect(RegisterMsg.safeParse({ ...msg, type: 'registerAck' }).success).toBe(false);
  });
});
