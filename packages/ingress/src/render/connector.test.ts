import { describe, expect, it } from 'bun:test';
import type { IngressConfig } from '../types';
import { buildConnectorServiceSpec } from './connector';

const config = (network?: string) =>
  ({ globalOptions: { ...(network ? { network } : {}) } }) as unknown as IngressConfig;

describe('cloudflared connector spec — networks', () => {
  it('joins the fronted-apps network AND the private swarmy-control (controller upstream)', () => {
    expect(buildConnectorServiceSpec(config()).networks).toEqual(['swarmy', 'swarmy-control']);
    expect(buildConnectorServiceSpec(config('edge')).networks).toEqual(['edge', 'swarmy-control']);
  });
});
