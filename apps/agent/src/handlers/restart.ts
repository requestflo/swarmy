/**
 * Restart this agent (`restartAgent`, board 11's "Restart agent").
 *
 * The agent never restarts itself: it answers the command, then exits through
 * the daemon's own clean shutdown (SIGTERM → timers, local socket and the
 * controller link closed) and lets what runs it start it again:
 *
 * - systemd: the installer's unit has `Restart=always` (`RestartSec=5`), and
 *   systemd sets `INVOCATION_ID` for every service it starts.
 * - Docker: the installers run the container `--restart unless-stopped`;
 *   `always` restarts too, and `on-failure` does when the exit code is 1.
 * - swarm: a service task is replaced by the scheduler (exit 1, so an
 *   `on-failure` restart condition also brings it back).
 *
 * Anything else (a dev run, a container without a restart policy, a binary
 * started by hand) would stay down, so it refuses with `E_NO_SUPERVISOR`.
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { AgentSupervisor, RestartAgentResult } from '@swarmy/core/protocol';
import { selfContainer } from '../self-container';

const SWARM_TASK_LABEL = 'com.docker.swarm.task.id';
/** Long enough for the command result to flush down the socket. */
const EXIT_FLUSH_MS = 750;

export interface SupervisorFacts {
  /** systemd's `INVOCATION_ID`, set for every unit it starts. */
  invocationId?: string;
  /** Our own container, when we run in one (null = not in a container). */
  container: { restartPolicy?: string; swarmTask: boolean } | null;
}

export type RestartPlan = { ok: true; supervisor: AgentSupervisor; exitCode: 0 | 1 } | { ok: false; reason: string };

/** Who would bring the agent back, and with which exit code (pure). */
export function restartPlan(f: SupervisorFacts): RestartPlan {
  if (f.invocationId) return { ok: true, supervisor: 'systemd', exitCode: 0 };
  const c = f.container;
  if (!c) {
    return {
      ok: false,
      reason: 'This agent runs outside systemd and outside a container, so nothing would start it again. Restart it on the server.',
    };
  }
  if (c.swarmTask) return { ok: true, supervisor: 'swarm', exitCode: 1 };
  if (c.restartPolicy === 'always' || c.restartPolicy === 'unless-stopped') return { ok: true, supervisor: 'docker', exitCode: 0 };
  if (c.restartPolicy === 'on-failure') return { ok: true, supervisor: 'docker', exitCode: 1 };
  return {
    ok: false,
    reason: `This agent's container has no restart policy (${c.restartPolicy || 'no'}), so Docker would not start it again. Restart it on the server.`,
  };
}

export interface RestartDeps {
  facts(): Promise<SupervisorFacts>;
  /** Leave once the answer has flushed. */
  leave(exitCode: 0 | 1): void;
}

export async function restartAgent(deps: RestartDeps): Promise<RestartAgentResult> {
  const plan = restartPlan(await deps.facts());
  if (!plan.ok) throw Object.assign(new Error(plan.reason), { code: 'E_NO_SUPERVISOR' });
  console.log(`[agent] restart requested by the controller; exiting so ${plan.supervisor} starts the agent again`);
  deps.leave(plan.exitCode);
  return { restarting: true, supervisor: plan.supervisor, exitCode: plan.exitCode };
}

export function defaultRestartDeps(docker: DockerClient): RestartDeps {
  return {
    async facts() {
      const self = await selfContainer(docker).catch(() => null);
      return {
        invocationId: process.env.INVOCATION_ID || undefined,
        container: self
          ? { restartPolicy: self.HostConfig?.RestartPolicy?.Name, swarmTask: Boolean(self.Config?.Labels?.[SWARM_TASK_LABEL]) }
          : null,
      };
    },
    leave(exitCode) {
      setTimeout(() => {
        process.exitCode = exitCode;
        // The daemon's SIGTERM handler is the clean shutdown; it exits with process.exitCode.
        process.kill(process.pid, 'SIGTERM');
      }, EXIT_FLUSH_MS);
    },
  };
}
