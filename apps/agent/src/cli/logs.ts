/**
 * `swarmy-agent logs [-f] [-n N] [--container <name>]` — journal / container
 * log access without remembering journalctl incantations.
 */
import { fail } from './context';

export async function logsCommand(argv: string[], options: Map<string, string>): Promise<void> {
  const follow = argv.includes('-f') || argv.includes('--follow');
  const lines = options.get('n') ?? argv[argv.indexOf('-n') + 1] ?? '100';
  const container = options.get('container');

  let cmd: string[];
  if (container) {
    cmd = ['docker', 'logs', ...(follow ? ['-f'] : []), '--tail', lines, container];
  } else if (await hasJournalctl()) {
    cmd = ['journalctl', '-u', 'swarmy-agent.service', '--no-pager', '-n', lines, ...(follow ? ['-f'] : [])];
  } else {
    // Container backend: the agent itself runs as a docker container.
    cmd = ['docker', 'logs', ...(follow ? ['-f'] : []), '--tail', lines, 'swarmy-agent'];
  }

  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  const code = await proc.exited;
  if (code !== 0 && !follow) fail(`${cmd[0]} exited with ${code}`);
  process.exit(code);
}

async function hasJournalctl(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['journalctl', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
