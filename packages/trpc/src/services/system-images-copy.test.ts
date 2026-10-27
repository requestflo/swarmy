import { describe, expect, it } from 'bun:test';
import { MIRROR_FAIL_MARKER, MIRROR_OK_MARKER, systemImage, type SystemImage, type SystemImageKey } from '@swarmy/core/system-images';
import { RunOncePayload, type RunOnceResult } from '@swarmy/core/protocol';
import { copyEachVia, copyPayload, copyVerdict, mirrorNote } from './system-images-copy';

/**
 * One labelled copy one-shot per image (`copyKey` = `<image@digest>`), so the
 * agent can find a copy a controller restart left running and wait on it; the
 * preflight counts such an image as in flight, never as failed.
 */
const d = (c: string) => `sha256:${c.repeat(64)}`;
const img = (key: string, digest: string | null = d('a')): SystemImage => ({
  key: key as SystemImageKey,
  ref: `ghcr.io/acme/${key}:1`,
  ...(digest ? { digest } : {}),
});
const k = (s: string) => s as SystemImageKey;
const ok = (key: string, digest = d('e')) => `${MIRROR_OK_MARKER} ${key} ${digest}`;

describe('copyPayload', () => {
  it('copies one image, keyed by its digest-pinned source (or its tag when the BOM pins none)', () => {
    const p = copyPayload(img('dns'), 'localhost:5000', null);
    expect(p.copyKey).toBe(`ghcr.io/acme/dns@${d('a')}`);
    expect(p.image).toBe(systemImage('regctl').ref);
    expect(p.cmd[0]).toContain(`regctl image copy 'ghcr.io/acme/dns@${d('a')}'`);
    expect(p.cmd[0]!.match(/regctl image copy/g)).toHaveLength(1);
    expect(copyPayload(img('agent', null), 'localhost:5000', null).copyKey).toBe('ghcr.io/acme/agent:1');
    // The wire accepts it (an older agent strips it and runs the copy as before).
    expect(RunOncePayload.parse({ commandId: '00000000-0000-4000-8000-000000000001', ...p }).copyKey).toBe(p.copyKey);
  });
});

describe('copyVerdict', () => {
  const res = (output: string, alreadyRunning?: boolean): RunOnceResult => ({ exitCode: 0, output, ...(alreadyRunning ? { alreadyRunning } : {}) });

  it('a copy it started: the digest that landed, else failed', () => {
    expect(copyVerdict(k('dns'), res(ok('dns')))).toEqual({ digest: d('e') });
    expect(copyVerdict(k('dns'), res(`${MIRROR_FAIL_MARKER} dns`))).toBe('failed');
    expect(copyVerdict(k('dns'), res(''))).toBe('failed');
  });

  it('a copy that was already running: its read-back output counts; nothing read back is in flight', () => {
    expect(copyVerdict(k('dns'), res(ok('dns'), true))).toEqual({ digest: d('e') });
    expect(copyVerdict(k('dns'), res(`${MIRROR_FAIL_MARKER} dns`, true))).toBe('failed');
    expect(copyVerdict(k('dns'), res('', true))).toBe('in-flight');
  });
});

describe('copyEachVia', () => {
  it('dispatches one copy per image and sorts the outcomes', async () => {
    const sent: string[] = [];
    const batch = copyEachVia(
      async (p) => {
        sent.push(p.copyKey);
        if (p.copyKey.includes('/b@')) return { exitCode: 0, output: '', alreadyRunning: true };
        if (p.copyKey.includes('/c@')) throw new Error('timed out');
        return { exitCode: 0, output: ok('a') };
      },
      'localhost:5000',
      null,
    );
    const out = await batch([img('a'), img('b'), img('c')]);
    expect(sent).toHaveLength(3);
    expect([...out.ok.keys()]).toEqual([k('a')]);
    expect(out.inFlight).toEqual([k('b')]);
    expect(out.failed).toEqual([k('c')]);
  });

  it('rejects when no copy could be dispatched at all (the agent is unreachable)', async () => {
    const batch = copyEachVia(async () => Promise.reject(new Error('node offline')), 'localhost:5000', null);
    await expect(batch([img('a'), img('b')])).rejects.toThrow('node offline');
  });
});

describe('mirrorNote — the preflight line', () => {
  it('counts in-flight copies apart from failures', () => {
    expect(mirrorNote({ copied: ['a'], failed: [], inFlight: ['b', 'c'] })).toBe(
      'release images in the cluster registry: 1 copied, 2 still copying (started before a controller restart)',
    );
    expect(mirrorNote({ copied: [], failed: ['x'] })).toBe('release images in the cluster registry: 0 copied, 1 failed (upstream fallback)');
    expect(mirrorNote({ copied: [], failed: [], skipped: 'registry disabled' })).toBe(
      'images not pre-copied (registry disabled); nodes pull them from upstream',
    );
  });
});
