import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildPlatformManifest, canonicalManifestJson } from '@swarmy/core/platform-manifest';
import { signPlatformManifest } from '@swarmy/core/platform-verify';
import { releaseForBuild } from './release';

const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const BOM = [{ key: 'agent' as const, ref: 'ghcr.io/requestflo/swarmy-agent:latest' }];

const m = (version: string, commit = 'abc1234') =>
  buildPlatformManifest({ version, channel: 'stable', commit, bom: BOM, publishedAt: '2026-09-25T00:00:00.000Z', agentBinaries: { 'linux-x64': 'a'.repeat(64) } });

describe('releaseForBuild (the signed manifest served to node installers)', () => {
  const mine = m('1.2.0');
  const signed = { manifest: mine, signature: signPlatformManifest(mine, PRIV) };

  it('serves the canonical bytes + signature of the release matching this build', () => {
    const r = releaseForBuild([null, { manifest: m('1.1.0') }, signed], { version: '1.2.0', commit: 'abc1234' }, PUB);
    expect(r?.body).toBe(canonicalManifestJson(mine));
    expect(r?.signature).toBe(signed.signature);
  });

  it('another version, another commit, or no signature ⇒ nothing (the installer falls back with a warning)', () => {
    expect(releaseForBuild([signed], { version: '1.3.0', commit: 'abc1234' }, PUB)).toBeNull();
    expect(releaseForBuild([signed], { version: '1.2.0', commit: 'fff0000' }, PUB)).toBeNull();
    expect(releaseForBuild([{ manifest: mine, signature: '' }], { version: '1.2.0', commit: 'abc1234' }, null)).toBeNull();
    expect(releaseForBuild([{ manifest: 'garbage', signature: 'x' }], { version: '1.2.0', commit: 'abc1234' }, null)).toBeNull();
    // A dev build commit ('dev') does not block a version match.
    expect(releaseForBuild([signed], { version: '1.2.0', commit: 'dev' }, PUB)).not.toBeNull();
  });

  it('with a release key, only a copy that verifies is served', () => {
    const forged = { manifest: { ...mine, agentBinaries: { 'linux-x64': { sha256: 'b'.repeat(64) } } }, signature: signed.signature };
    expect(releaseForBuild([forged], { version: '1.2.0', commit: 'abc1234' }, PUB)).toBeNull();
    // Without a key the controller cannot vouch; it still serves, and the node's own key decides.
    expect(releaseForBuild([forged], { version: '1.2.0', commit: 'abc1234' }, null)).not.toBeNull();
  });

  it('serves the stored raw signed bytes verbatim (a field this build does not know survives, QA-070)', () => {
    const raw = `${JSON.stringify({ ...mine, futureField: 1 }, null, 2)}\n`;
    const signature = sign('sha256', Buffer.from(raw), kp.privateKey).toString('base64');
    const r = releaseForBuild([{ manifest: mine, raw, signature }], { version: '1.2.0', commit: 'abc1234' }, PUB);
    expect(r?.body).toBe(raw);
  });
});
