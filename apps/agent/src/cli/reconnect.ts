/**
 * `swarmy-agent reconnect` — force an immediate redial to the controller.
 * Daemon running → ask it over the unix socket (collapses backoff, redials
 * now). Daemon dead → restart the service instead, which is the honest fix.
 */
import { daemonReconnect, daemonStatus, fail, fmt, say } from './context';

export async function reconnectCommand(): Promise<void> {
  const daemon = await daemonStatus();

  if (daemon) {
    const ok = await daemonReconnect();
    if (!ok) fail('daemon socket did not accept the reconnect request');
    say(`${fmt.green('✓')} redial requested — watch: swarmy-agent logs -f`);
    // Give it a moment, then report the outcome if it's already visible.
    await new Promise((r) => setTimeout(r, 3_000));
    const after = await daemonStatus();
    if (after?.connected) {
      say(`${fmt.green('✓')} connected — registered as ${after.nodeId ?? '(pending ack)'}`);
    } else if (after?.lastAuthReject && after.lastAuthReject.at > Date.now() - 10_000) {
      say(fmt.red(`✗ controller rejected auth: ${after.lastAuthReject.code} ${after.lastAuthReject.reason}`));
      say(fmt.dim('  Re-run the install one-liner from the dashboard (repair mode) to re-authenticate this node.'));
      process.exit(1);
    } else {
      say(fmt.yellow('… still dialing — check `swarmy-agent status` in a few seconds'));
    }
    return;
  }

  say(fmt.yellow('daemon is not running — restarting the service instead'));
  const proc = Bun.spawn(['systemctl', 'restart', 'swarmy-agent.service'], { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) {
    fail('could not restart swarmy-agent.service (not a systemd install? try: docker restart swarmy-agent)');
  }
  say(`${fmt.green('✓')} service restarted — watch: swarmy-agent logs -f`);
}
