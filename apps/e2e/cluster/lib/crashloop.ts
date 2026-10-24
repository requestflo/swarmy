/**
 * "Is this stack ever going to answer?" — read off Docker while a step waits.
 *
 * A step that polls an app's URL for ten minutes learns nothing when the app
 * is crash-looping: the nightly once spent 600 s on umami restarting every
 * 30 s because it couldn't reach its database on another node. Swarm already
 * knows: every attempt is a task that ended `Failed` with an exit code. Once
 * a service has burned through `maxFailed` tasks, stop waiting and say which
 * service, its error and its last log lines.
 */
import type { Ctx } from '../context';

/** Pure: how many of `docker service ps --format '{{.CurrentState}}'` lines are failed attempts. */
export function failedAttempts(psStates: string): number {
  return psStates.split('\n').filter((l) => /^(Failed|Rejected)\b/.test(l.trim())).length;
}

/** → why the stack can't come up, or null while Docker is still trying. Never throws. */
export async function crashLoop(ctx: Ctx, stack: string, maxFailed = 4): Promise<string | null> {
  try {
    const services = (await ctx.docker(`service ls --filter label=com.docker.stack.namespace=${stack} --format '{{.Name}}'`)).split('\n').filter(Boolean);
    for (const svc of services) {
      const ps = await ctx.docker(`service ps ${svc} --no-trunc --format '{{.CurrentState}}|{{.Error}}'`);
      const states = ps.split('\n').map((l) => l.split('|')[0] ?? '');
      if (failedAttempts(states.join('\n')) < maxFailed) continue;
      const error = ps.split('\n').map((l) => l.split('|')[1]?.trim()).find(Boolean) ?? 'no error recorded';
      const logs = await ctx.docker(`service logs --raw --tail 6 ${svc} 2>&1`, 30_000).catch(() => '');
      const tail = logs.trim().split('\n').slice(-6).join(' ⏎ ').slice(0, 500);
      return `${svc} is crash-looping (${failedAttempts(states.join('\n'))} failed tasks, ${error})${tail ? `; last log lines: ${tail}` : ''}`;
    }
  } catch {
    // Docker unreachable for a moment: keep polling.
  }
  return null;
}
