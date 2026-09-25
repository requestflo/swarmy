import { describe, expect, test } from 'bun:test';
import { livePorts } from './docker';

describe('livePorts (QA-009)', () => {
  test('a spec port with no published value reports the swarm-assigned public port', () => {
    expect(
      livePorts([{ TargetPort: 80, PublishedPort: 30001, Protocol: 'tcp' }], [{ TargetPort: 80, Protocol: 'tcp' }]),
    ).toEqual([{ target: 80, published: 30001, protocol: 'tcp' }]);
  });
  test('falls back to the spec while the endpoint is not allocated', () => {
    expect(livePorts(undefined, [{ TargetPort: 53, PublishedPort: 53, Protocol: 'udp' }])).toEqual([
      { target: 53, published: 53, protocol: 'udp' },
    ]);
    expect(livePorts([], [{ TargetPort: 80 }])).toEqual([{ target: 80, protocol: 'tcp' }]);
    expect(livePorts(undefined, undefined)).toEqual([]);
  });
});
