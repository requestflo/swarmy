import { prisma } from '@swarmy/db';

/**
 * Controller-side persistence for terminal sessions (epic #11). The control
 * plane (tRPC) creates the `TerminalSession` row at `terminal.open`; this data
 * plane updates it on close with exit/bytes/recording. Both reach the (newly
 * added, INTEGRATION-snippet) `TerminalSession` model through a single narrow
 * cast so the rest of the code is fully typed before the migration lands.
 */

interface TerminalSessionDelegate {
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<unknown>;
}

interface TerminalPolicyRowLike {
  recordContainerExec?: boolean;
  idleTimeoutMs?: number;
}
interface TerminalPolicyDelegate {
  findUnique(args: { where: { orgId: string } }): Promise<TerminalPolicyRowLike | null>;
}

function sessions(): TerminalSessionDelegate {
  return (prisma as unknown as { terminalSession: TerminalSessionDelegate }).terminalSession;
}

function policies(): TerminalPolicyDelegate {
  return (prisma as unknown as { terminalPolicy: TerminalPolicyDelegate }).terminalPolicy;
}

export interface TerminalRuntimePolicy {
  recordContainerExec: boolean;
  idleTimeoutMs: number;
}

const DEFAULT_RUNTIME_POLICY: TerminalRuntimePolicy = {
  recordContainerExec: true,
  idleTimeoutMs: 300_000,
};

/** Read the org's record/idle knobs (safe defaults if no row). Best-effort. */
export async function loadTerminalRuntimePolicy(orgId: string): Promise<TerminalRuntimePolicy> {
  try {
    const row = await policies().findUnique({ where: { orgId } });
    if (!row) return DEFAULT_RUNTIME_POLICY;
    return {
      recordContainerExec: row.recordContainerExec ?? DEFAULT_RUNTIME_POLICY.recordContainerExec,
      idleTimeoutMs: row.idleTimeoutMs ?? DEFAULT_RUNTIME_POLICY.idleTimeoutMs,
    };
  } catch {
    return DEFAULT_RUNTIME_POLICY;
  }
}

/** Finalise a session row when its WS / agent stream ends. Best-effort. */
export async function finalizeTerminalSession(
  id: string,
  data: {
    exitCode: number | null;
    reason: string;
    bytesIn: number;
    bytesOut: number;
    recordingRef?: string | null;
  },
): Promise<void> {
  await sessions()
    .update({
      where: { id },
      data: {
        endedAt: new Date(),
        exitCode: data.exitCode,
        reason: data.reason,
        bytesIn: data.bytesIn,
        bytesOut: data.bytesOut,
        ...(data.recordingRef !== undefined ? { recordingRef: data.recordingRef } : {}),
      },
    })
    .catch(() => undefined);
}
