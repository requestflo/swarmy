import { describe, expect, test } from 'bun:test';
import { controllerDialUrl } from './controller-link';
import { agentNetworkMode } from './handlers/update';

describe('controller link off the overlay (QA-066 e)', () => {
  const url = 'ws://swarmy_controller:3021/agent/ws';

  test('dials the node that runs the controller, on its host-mode published port', () => {
    expect(controllerDialUrl(url, { taskNodeAddrs: ['100.106.243.149'], publishedPort: 3021 })).toBe('ws://100.106.243.149:3021/agent/ws');
    expect(controllerDialUrl(url, { taskNodeAddrs: ['100.106.243.149'], publishedPort: 8080 })).toBe('ws://100.106.243.149:8080/agent/ws');
  });

  test('no swarm answer (a worker, or no leader yet): this host, where a single-node controller runs', () => {
    expect(controllerDialUrl(url, null)).toBe('ws://127.0.0.1:3021/agent/ws');
    expect(controllerDialUrl(url, { taskNodeAddrs: [] })).toBe('ws://127.0.0.1:3021/agent/ws');
  });

  test('the self-update moves an overlay agent to the host network and keeps every other mode', () => {
    expect(agentNetworkMode('swarmy-control')).toBe('host');
    expect(agentNetworkMode('swarmy')).toBe('host');
    for (const m of ['host', 'bridge', 'default', 'none', 'container:abc']) expect(agentNetworkMode(m)).toBe(m);
    expect(agentNetworkMode(undefined)).toBeUndefined();
  });
});

describe('self container lookup on the host network (QA-066 e)', () => {
  test('finds the id in Docker’s own bind mounts', async () => {
    const { containerIdFromMountinfo } = await import('./self-container');
    const id = 'c2dc60277ab9f7f2160dde565c4a12676ab30ce162a9a70c07cc9ae63813a926';
    const mi = `2403 2385 0:22 /docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw\n`;
    expect(containerIdFromMountinfo(mi)).toBe(id);
    expect(containerIdFromMountinfo('23 1 0:22 / / rw - ext4 /dev/vda1 rw\n')).toBeUndefined();
  });
});
