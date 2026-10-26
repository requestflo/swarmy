/**
 * Optional agent commands, advertised in the register facts
 * (`NodeFacts.capabilities`).
 *
 * `PROTOCOL_VERSION` is the wire contract every agent speaks, and bumping it
 * changes the WS subprotocol (a breaking change). A command added later is
 * additive instead: an agent that predates it fails `parseControllerEnvelope`
 * on the unknown `type` and drops the frame silently, so the controller would
 * only see a timeout. So such a command is listed here, the agent advertises
 * the list, and the controller dispatches the command only to an agent that
 * advertised it (`agentSupports`), falling back to the old behaviour otherwise.
 *
 * Append only: never rename or remove a capability.
 */

/** Each capability is the wire `type` of the command it stands for. */
export const AGENT_CAPABILITY = {
  /** Read-only: a PITR cluster's base backups and recoverable window (`dbPitrWindow`). */
  dbPitrWindow: 'dbPitrWindow',
  /** Re-image the NetBird client sidecar in place, reconnect-checked (`reimageMesh`, the upgrade's mesh step). */
  reimageMesh: 'reimageMesh',
  /** Read-only: the certificates this node's edge Caddy holds, `.crt` facts only (`edgeCerts`). */
  edgeCerts: 'edgeCerts',
  /** Re-issue one certificate on this node's edge Caddy, old one put back if none comes (`edgeCertRenew`). */
  edgeCertRenew: 'edgeCertRenew',
  /** Exit cleanly after answering so systemd / Docker / swarm restarts the agent (`restartAgent`, board 11). */
  restartAgent: 'restartAgent',
  /**
   * The outbound port-25 probe (`probeSmtp`, board 66's per-server test). The
   * command dates from 2026-09-24, before capabilities; advertising it lets
   * the controller ask every server without sending a frame an agent would drop.
   */
  probeSmtp: 'probeSmtp',
  /** Read-only: is a wal-g PITR cluster's WAL archive continuous (`dbWalVerify`, `wal-g wal-verify`)? */
  dbWalVerify: 'dbWalVerify',
} as const;
export type AgentCapability = (typeof AGENT_CAPABILITY)[keyof typeof AGENT_CAPABILITY];

/** Everything this build of the agent understands beyond the base protocol. */
export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  AGENT_CAPABILITY.dbPitrWindow,
  AGENT_CAPABILITY.reimageMesh,
  AGENT_CAPABILITY.edgeCerts,
  AGENT_CAPABILITY.edgeCertRenew,
  AGENT_CAPABILITY.restartAgent,
  AGENT_CAPABILITY.probeSmtp,
  AGENT_CAPABILITY.dbWalVerify,
];

/**
 * Does an agent with these advertised capabilities understand `cap`? An
 * absent list is an agent that predates capabilities: no. Pure.
 */
export function agentSupports(capabilities: readonly string[] | undefined, cap: AgentCapability): boolean {
  return Array.isArray(capabilities) && capabilities.includes(cap);
}
