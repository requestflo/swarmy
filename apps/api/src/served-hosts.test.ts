import { describe, expect, it } from 'bun:test';
import { servedHostsFrom } from './served-hosts';

describe('servedHostsFrom (QA-001)', () => {
  it('advertise addresses (port stripped) and public IPs (override first), deduped', () => {
    const nodes = [
      [
        { swarmNodeId: 'a', hostname: 'n1', addr: '10.0.0.5', labels: { 'swarmy.node.public-ip': '46.101.22.121' } },
        { swarmNodeId: 'b', hostname: 'n2', addr: '10.0.0.6:2377', labels: { 'swarmy.node.public-ip': '1.2.3.4', 'swarmy.node.public-ip.override': '5.6.7.8' } },
      ],
      [{ swarmNodeId: 'a', hostname: 'n1', addr: '10.0.0.5', labels: {} }],
    ] as never;
    expect(servedHostsFrom(nodes)).toEqual(['10.0.0.5', '46.101.22.121', '10.0.0.6', '5.6.7.8']);
  });
});
