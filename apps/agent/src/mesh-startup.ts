/**
 * Why a node did NOT join a mesh at startup, in words (pure, see
 * mesh-startup.test.ts). The mesh-first join used to return silently when
 * mesh was disabled or no setup key was configured, so a node that lost its
 * key (issues/manual-recovery-required-not-magical.md item 5) came up with no
 * mesh client and not a single log line saying so. The daemon logs this line
 * and `doctor` shows it.
 */
export interface MeshStartupInputs {
  /** SWARMY_ALLOW_MESH (the node's own capability gate). */
  allowMesh: boolean;
  /** A SWARMY_MESH_SETUP_KEY is configured. */
  hasSetupKey: boolean;
}

/** `null` = nothing stops the join; otherwise the one line to log. */
export function meshSkipReason({ allowMesh, hasSetupKey }: MeshStartupInputs): string | null {
  if (!allowMesh && hasSetupKey) {
    return (
      'SWARMY_ALLOW_MESH=false on this node: the configured mesh setup key is ignored and no mesh client starts. ' +
      'Set SWARMY_ALLOW_MESH=true in /etc/swarmy/agent.env (or re-run the install one-liner with it) to join the mesh.'
    );
  }
  if (!allowMesh) return 'mesh disabled on this node (SWARMY_ALLOW_MESH=false): not joining a mesh';
  if (!hasSetupKey) {
    return (
      'no mesh client running and no SWARMY_MESH_SETUP_KEY configured: not joining a mesh at startup. ' +
      'If this org uses a mesh, re-run the install one-liner from the dashboard (it carries a fresh key).'
    );
  }
  return null;
}
