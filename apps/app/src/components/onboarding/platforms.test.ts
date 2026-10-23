import { describe, expect, test } from 'bun:test';
import { cloudConfig, platformOf, PLATFORMS } from './platforms';

describe('platforms', () => {
  test('only the clouds paste cloud-config; the rest run the line', () => {
    expect(PLATFORMS.filter((p) => p.cloudConfig).map((p) => p.id)).toEqual(['hetzner', 'digitalocean']);
  });

  test('an unknown id falls back to Any Linux', () => {
    expect(platformOf('nope' as never).id).toBe('linux');
  });

  test('cloud-config carries the exact line as a literal runcmd block', () => {
    const line = 'curl -fsSL https://x.dev/install/loader.sh | SWARMY_JOIN_TOKEN=swj_a_b SWARMY_NODE_LABELS=zone=eu,disk=ssd sh -s -- --controller https://x.dev';
    const doc = cloudConfig(line);
    expect(doc.split('\n')[0]).toBe('#cloud-config');
    expect(doc).toContain('runcmd:\n  - |\n');
    // A literal block: the line survives byte for byte, colons and commas included.
    expect(doc.endsWith(`    ${line}`)).toBe(true);
  });
});
