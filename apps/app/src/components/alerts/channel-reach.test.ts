import { describe, expect, it } from 'bun:test';
import { channelReach, reachWords } from './channel-reach';

const rule = (channelIds: string[], enabled = true) => ({ channelIds, enabled });
const RULES = [rule([]), rule([]), rule(['slack']), rule(['email']), rule(['slack', 'email']), rule(['slack'], false)];

describe('channelReach: "Gets N of M rules"', () => {
  it('counts the rules that name it plus the every-channel ones, out of the enabled rules', () => {
    expect(channelReach({ id: 'slack', enabled: true }, RULES)).toEqual({ gets: 4, of: 5, named: 2 });
    expect(channelReach({ id: 'email', enabled: true }, RULES)).toEqual({ gets: 4, of: 5, named: 2 });
    expect(channelReach({ id: 'hook', enabled: true }, RULES)).toEqual({ gets: 2, of: 5, named: 0 });
  });

  it('a channel that is off gets nothing', () => {
    expect(channelReach({ id: 'slack', enabled: false }, RULES)).toEqual({ gets: 0, of: 5, named: 0 });
  });

  it('says it plainly', () => {
    expect(reachWords({ gets: 4, of: 5, named: 2 }, true)).toBe('Gets 4 of 5 rules');
    expect(reachWords({ gets: 14, of: 14, named: 0 }, true)).toBe('Gets all 14 rules');
    expect(reachWords({ gets: 0, of: 0, named: 0 }, true)).toBe('No rules yet');
    expect(reachWords({ gets: 0, of: 5, named: 0 }, false)).toBe('Off: gets no rules');
  });
});
