import { describe, expect, it } from 'bun:test';
import { driftHeadline, driftSay, driftTech, driftWhy, type DriftRowLite } from './drift-words';

const row = (over: Partial<DriftRowLite>): DriftRowLite => ({
  service: 'swarmy-dns',
  key: 'dns',
  owner: 'system',
  running: 'ghcr.io/requestflo/swarmy-dns:latest',
  expected: 'ghcr.io/requestflo/swarmy-dns@sha256:dd',
  kind: 'floating',
  action: 'repin',
  ...over,
});

describe('drift words', () => {
  it('counts in words and agrees in number', () => {
    expect(driftHeadline(1, '1.3.0')).toBe("One of swarmy's own services isn't on 1.3.0.");
    expect(driftHeadline(2, '1.3.0')).toBe("Two of swarmy's own services aren't on 1.3.0.");
    expect(driftHeadline(12, '1.3.0')).toBe("12 of swarmy's own services aren't on 1.3.0.");
  });

  it('says what is off without glossary words; the exact images are the tech line', () => {
    const lines = [
      driftSay(row({}), '1.3.0'),
      driftSay(row({ kind: 'digest' }), '1.3.0'),
      driftSay(row({ owner: 'controller', action: 'explain', kind: 'digest' }), '1.3.0'),
      driftSay(row({ owner: 'engine', action: 'explain', kind: 'digest' }), '1.3.0'),
      driftWhy(row({ owner: 'engine', action: 'explain' }), '1.3.0'),
    ];
    expect(lines[0]).toBe('Runs a floating tag, so a restart could pull another build.');
    expect(lines[1]).toBe('Runs another build than 1.3.0 names.');
    for (const l of lines) expect(l).not.toMatch(/digest|replica|node|stack/i);
    expect(driftTech(row({ expected: null, kind: 'tag' }))).toBe('ghcr.io/requestflo/swarmy-dns:latest → no exact build named');
  });

  it('explains why the controller and object storage are not re-pinned from here', () => {
    expect(driftWhy(row({ owner: 'controller' }), '1.3.0')).toMatch(/only moves during an upgrade/);
    expect(driftWhy(row({ owner: 'system', kind: 'tag', expected: null }), '0.0.0')).toMatch(/nothing to pin it to/);
  });
});
