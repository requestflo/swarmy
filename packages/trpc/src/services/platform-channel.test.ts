import { describe, expect, it } from 'bun:test';
import { channelOfVersion } from '@swarmy/core/platform-manifest';
import { CHOSEN_STABLE, effectiveChannel } from './platform-release.service';

describe('platform channel default (QA-020)', () => {
  it('an edge build is on the edge channel', () => {
    expect(channelOfVersion('1.4.1-edge.212')).toBe('edge');
    expect(channelOfVersion('1.4.0')).toBe('stable');
  });

  it('the column default follows the installed build', () => {
    expect(effectiveChannel('stable', '1.4.1-edge.212')).toBe('edge');
    expect(effectiveChannel(null, '1.4.1-edge.212')).toBe('edge');
    expect(effectiveChannel('stable', '1.4.0')).toBe('stable');
  });

  it('an explicit choice wins over the build', () => {
    expect(effectiveChannel(CHOSEN_STABLE, '1.4.1-edge.212')).toBe('stable');
    expect(effectiveChannel('edge', '1.4.0')).toBe('edge');
  });
});
