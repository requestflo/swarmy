import { describe, expect, it } from 'bun:test';
import { EDGE_NETWORK, servicesMissingEdge } from './ingress-network';

const routed = { 'swarmy.ingress.routes': JSON.stringify([{ host: 'a.example.com', port: 80 }]) };

describe('servicesMissingEdge', () => {
  it('flags routed services that are not on the edge overlay', () => {
    expect(
      servicesMissingEdge([
        { name: 'web', labels: routed, networks: [] },
        { name: 'api', labels: routed, networks: [{ name: EDGE_NETWORK }] },
        { name: 'worker', labels: {}, networks: [] },
      ]),
    ).toEqual(['web']);
  });
});
