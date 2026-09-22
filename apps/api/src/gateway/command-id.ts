/**
 * The wire `commandId` for a dispatch. A caller-supplied `payload.commandId`
 * is honoured (e.g. a build's `Build.logsRef`, so the agent's `logChunk`s are
 * keyed by the id the build-log bus is read by); otherwise — or if that id is
 * already in flight — a fresh UUID is minted.
 */
export function pickCommandId(payload: unknown, inFlight: (id: string) => boolean): string {
  const supplied = (payload as { commandId?: unknown } | null | undefined)?.commandId;
  if (typeof supplied === 'string' && supplied.length > 0 && !inFlight(supplied)) return supplied;
  return crypto.randomUUID();
}
