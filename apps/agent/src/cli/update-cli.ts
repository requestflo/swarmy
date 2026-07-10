/**
 * `swarmy-agent update` — self-update from the controller's binary manifest,
 * reusing the exact download/verify/swap machinery the controller-pushed
 * `updateAgent` command uses (checksum-pinned, --version sanity probe,
 * .old rollback copy kept next to the binary).
 */
import { agentPackaging, selfReplaceAt } from '../handlers/update';
import { versionInfo } from '../version';
import { controllerHttpBase, fail, fmt, say } from './context';

export async function updateCommand(): Promise<void> {
  if (agentPackaging() !== 'binary') {
    fail(
      'this agent runs interpreted (container backend) — update it by re-pulling the image ' +
        'or letting the controller push a docker-recreate update',
    );
  }

  const base = controllerHttpBase();
  const v = versionInfo();
  say(`current: v${v.version} (commit ${v.commit})`);

  const res = await fetch(`${base}/install/bin/manifest.json`, { signal: AbortSignal.timeout(10_000) }).catch(
    (err: Error) => fail(`controller unreachable at ${base}: ${err.message}`),
  );
  if (!res.ok) fail(`controller returned HTTP ${res.status} for the binary manifest`);
  const manifest = (await res.json()) as {
    version: string;
    commit?: string;
    platforms: Record<string, { sha256: string; size: number }>;
  };

  const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const entry = manifest.platforms[platform];
  if (!entry) fail(`controller has no binary for ${platform} (has: ${Object.keys(manifest.platforms).join(', ')})`);

  if (manifest.version === v.version && (manifest.commit ?? v.commit) === v.commit) {
    say(`${fmt.green('✓')} already up to date (controller serves the same version+commit)`);
    return;
  }

  say(`updating to v${manifest.version}${manifest.commit ? ` (commit ${manifest.commit})` : ''}…`);
  await selfReplaceAt(
    {
      targetVersion: manifest.version,
      downloadUrl: `${base}/install/bin/${platform}`,
      sha256: entry.sha256,
      strategy: 'self-replace',
    } as Parameters<typeof selfReplaceAt>[0],
    process.execPath,
  );
  say(`${fmt.green('✓')} binary swapped (previous kept at ${process.execPath}.old)`);
  say('restarting the service to pick it up…');
  const proc = Bun.spawn(['systemctl', 'restart', 'swarmy-agent.service'], { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) {
    say(fmt.yellow('could not restart via systemd — restart the agent manually to run the new binary'));
  } else {
    say(`${fmt.green('✓')} service restarted`);
  }
}
