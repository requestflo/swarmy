import { z } from 'zod';
import { MessageId } from './primitives';

export const ProtocolErrorCode = z.enum([
  'E_MALFORMED',
  'E_UNSUPPORTED_VERSION',
  'E_UNAUTHORIZED',
  'E_TOKEN_REVOKED',
  'E_TOKEN_EXHAUSTED',
  'E_MSG_TOO_LARGE',
  'E_RATE_LIMITED',
  'E_UNKNOWN_COMMAND',
  'E_COMMAND_TIMEOUT',
  'E_NOT_MANAGER',
  'E_DOCKER',
  'E_IMAGE_PULL',
  'E_INGRESS',
  'E_EXEC_DISABLED',
  'E_INTERNAL',
]);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>;

/** Carried by both `error` messages (agent and controller directions). */
export const ErrorPayload = z.object({
  code: z.string(),
  message: z.string(),
  /** The offending message id, if this error relates to a specific frame. */
  relatesTo: MessageId.optional(),
  fatal: z.boolean().default(false),
});
export type ErrorPayload = z.infer<typeof ErrorPayload>;

export class ProtocolError extends Error {
  constructor(
    public code: ProtocolErrorCode,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
