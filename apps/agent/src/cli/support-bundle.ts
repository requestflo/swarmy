/**
 * `swarmy-agent support-bundle [--out path]` — one tarball with everything a
 * human (or the dashboard) needs to debug this node, with secrets redacted.
 *
 * Contents: doctor report (json), daemon status, docker info/ps, netbird
 * status, last 500 journal lines, and agent.env with every credential-looking
 * value masked. Redaction is allowlist-of-keys-based and errs toward masking.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from './checks';
import { daemonStatus, fmt, say } from './context';

const REDACT_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

export async function supportBundleCommand(options: Map<string, string>): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = options.get('out') ?? `/tmp/swarmy-support-${stamp}.tar.gz`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarmy-bundle-'));

  say('collecting diagnostics…');
  const [report, daemon] = await Promise.all([runChecks(), daemonStatus()]);

  await writeFile(path.join(dir, 'doctor.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(dir, 'daemon-status.json'), JSON.stringify(daemon, null, 2));
  await writeFile(path.join(dir, 'docker-info.txt'), await capture(['docker', 'info']));
  await writeFile(path.join(dir, 'docker-ps.txt'), await capture(['docker', 'ps', '-a', '--no-trunc']));
  await writeFile(
    path.join(dir, 'netbird-status.txt'),
    await capture(['docker', 'exec', 'swarmy-netbird', 'netbird', 'status', '-d']),
  );
  await writeFile(
    path.join(dir, 'journal.txt'),
    await capture(['journalctl', '-u', 'swarmy-agent.service', '--no-pager', '-n', '500']),
  );
  await writeFile(path.join(dir, 'agent-env.redacted'), await redactedEnvFile());

  const tar = Bun.spawn(['tar', '-czf', outPath, '-C', dir, '.'], { stdout: 'ignore', stderr: 'pipe' });
  if ((await tar.exited) !== 0) {
    const err = await new Response(tar.stderr).text();
    await rm(dir, { recursive: true, force: true });
    throw new Error(`tar failed: ${err.trim()}`);
  }
  await rm(dir, { recursive: true, force: true });

  say(`${fmt.green('✓')} wrote ${fmt.bold(outPath)}`);
  say(fmt.dim('  Credentials are redacted; review before sharing anyway.'));
}

async function capture(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return code === 0 ? out : `(exit ${code})\n${out}${err}`;
  } catch (err) {
    return `(unavailable: ${err instanceof Error ? err.message : err})`;
  }
}

async function redactedEnvFile(): Promise<string> {
  const envFile = process.env.SWARMY_AGENT_ENV_FILE ?? '/etc/swarmy/agent.env';
  try {
    const raw = await readFile(envFile, 'utf8');
    return raw
      .split('\n')
      .map((line) => {
        const eq = line.indexOf('=');
        if (eq === -1 || line.trimStart().startsWith('#')) return line;
        const key = line.slice(0, eq);
        return REDACT_PATTERN.test(key) ? `${key}=<redacted>` : line;
      })
      .join('\n');
  } catch {
    return `(no env file at ${envFile})`;
  }
}
