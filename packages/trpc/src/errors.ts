import { TRPCError } from '@trpc/server';

/** A swarmy-specific code surfaced to the client via the errorFormatter. */
export type SwarmyCode =
  | 'NODE_OFFLINE'
  | 'NO_MANAGER'
  | 'COMMAND_TIMEOUT'
  | 'COMMAND_REJECTED'
  | 'NOT_FOUND'
  | 'POLICY_DENIED'
  /** The operation needs an interactive browser round-trip (OAuth / GitHub App install) — use the dashboard. */
  | 'BROWSER_FLOW_REQUIRED';

type TRPCCode = ConstructorParameters<typeof TRPCError>[0]['code'];

function err(code: TRPCCode, message: string, swarmyCode: SwarmyCode): TRPCError {
  return new TRPCError({ code, message, cause: { swarmyCode } });
}

export function notFound(kind: string, id?: string): TRPCError {
  return err('NOT_FOUND', `${kind}${id ? ` "${id}"` : ''} not found`, 'NOT_FOUND');
}

export function nodeOffline(nodeId: string): TRPCError {
  return err('PRECONDITION_FAILED', `node ${nodeId} is offline`, 'NODE_OFFLINE');
}

export function noManager(): TRPCError {
  return err('PRECONDITION_FAILED', 'no online manager node', 'NO_MANAGER');
}

export function commandTimeout(): TRPCError {
  return err('TIMEOUT', 'agent did not respond in time', 'COMMAND_TIMEOUT');
}

export function commandRejected(message: string): TRPCError {
  return err('BAD_REQUEST', message, 'COMMAND_REJECTED');
}

/** A policy denied the action; carries the deciding policy id in `cause`. */
export function policyDenied(action: string, policyId: string | null): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: `not permitted: ${action}`,
    cause: { swarmyCode: 'POLICY_DENIED', policyId },
  });
}

/** The operation can't complete without a browser round-trip (e.g. an OAuth grant); REST/Terraform refuse it. */
export function browserFlowRequired(message: string): TRPCError {
  return err('UNPROCESSABLE_CONTENT', message, 'BROWSER_FLOW_REQUIRED');
}

/** Invalid input the schema alone can't express (cross-field rules) — 400. */
export function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Map a dispatch failure into a typed TRPCError. */
export function mapDispatchError(e: unknown): TRPCError {
  if (e instanceof TRPCError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/timeout/i.test(message)) return commandTimeout();
  if (/offline/i.test(message)) return nodeOffline('unknown');
  return commandRejected(message);
}
