/**
 * `restartAgent`: restart the swarmy agent on one server (board 11's
 * "Restart agent"). No workload is touched.
 *
 * The agent answers first, then exits cleanly and lets what runs it bring it
 * back: systemd (`Restart=always`), Docker's restart policy (`unless-stopped`
 * from the installers), or the swarm scheduler for an agent run as a service
 * task. An agent nothing would restart (a dev run, a container with no restart
 * policy) refuses with `E_NO_SUPERVISOR` instead of going dark. The
 * controller then waits for the next register and says how long it took.
 *
 * Additive: gated by the `restartAgent` capability (`capabilities.ts`). An
 * older agent would drop the frame, so the dashboard shows no button for it.
 */
import { z } from 'zod';
import { CommandId } from './primitives';

export const RestartAgentPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
});
export type RestartAgentPayload = z.infer<typeof RestartAgentPayload>;

export const RestartAgentMsg = z.object({ type: z.literal('restartAgent'), payload: RestartAgentPayload });
export type RestartAgentMsg = z.infer<typeof RestartAgentMsg>;

/** What brings the agent back after it exits. */
export type AgentSupervisor = 'systemd' | 'docker' | 'swarm';

export interface RestartAgentResult {
  restarting: true;
  supervisor: AgentSupervisor;
  /** The exit code the agent leaves with (0, or 1 for an on-failure policy). */
  exitCode: 0 | 1;
}
