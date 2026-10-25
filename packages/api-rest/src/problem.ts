/**
 * RFC 9457 problem+json mapping. The services layer throws `TRPCError`s carrying
 * a `swarmyCode` (see `@swarmy/trpc/errors`). One mapper keeps both front doors
 * (tRPC + REST) consistent: tRPC code → HTTP status, `swarmyCode` carried through.
 */
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { invalidParamsFromFieldErrors, type InvalidParam } from './invalid-params';

/**
 * Structural shape of a `TRPCError` (we avoid a direct `@trpc/server` dep here —
 * the services layer throws these and they cross the package boundary as values).
 */
interface TRPCErrorLike {
  name: 'TRPCError';
  code: string;
  message: string;
  /**
   * `violations`: the admission refusal's list (`admissionDenied` in @swarmy/trpc).
   * `fieldErrors`: every field a whole-write validation refused (the ingress settings write).
   */
  cause?: { swarmyCode?: string; violations?: unknown; fieldErrors?: unknown };
}

function isTrpcError(e: unknown): e is TRPCErrorLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'name' in e &&
    (e as { name?: unknown }).name === 'TRPCError'
  );
}

/** One admission-policy violation (guardrails, exposure, image policy, the network wall). */
export interface ProblemViolation {
  rule: string;
  severity: 'block' | 'warn';
  message: string;
  resource?: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  swarmy_code?: string;
  /** Present when admission refused a deploy (412): every rule it broke. */
  violations?: ProblemViolation[];
  /** Present on a validation 400: every refused field and why. */
  invalid_params?: InvalidParam[];
}

/** The public fields of each violation — never whatever else rides on `cause`. */
function violationsOf(raw: unknown): ProblemViolation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProblemViolation[] = [];
  for (const v of raw as Record<string, unknown>[]) {
    if (!v || typeof v.rule !== 'string' || typeof v.message !== 'string') continue;
    out.push({
      rule: v.rule,
      severity: v.severity === 'warn' ? 'warn' : 'block',
      message: v.message,
      ...(typeof v.resource === 'string' ? { resource: v.resource } : {}),
    });
  }
  return out;
}

const TRPC_TO_HTTP: Record<string, number> = {
  PARSE_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 504,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
  CLIENT_CLOSED_REQUEST: 499,
  INTERNAL_SERVER_ERROR: 500,
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  504: 'Gateway Timeout',
};

export function trpcErrorToProblem(e: unknown, instance?: string): Problem {
  if (isTrpcError(e)) {
    const status = TRPC_TO_HTTP[e.code] ?? 500;
    const violations = violationsOf(e.cause?.violations);
    const invalidParams = invalidParamsFromFieldErrors(e.cause?.fieldErrors);
    return {
      type: `https://swarmy.dev/problems/${e.code.toLowerCase()}`,
      title: TITLES[status] ?? 'Error',
      status,
      detail: e.message,
      instance,
      swarmy_code: e.cause?.swarmyCode,
      ...(violations ? { violations } : {}),
      ...(invalidParams ? { invalid_params: invalidParams } : {}),
    };
  }
  // Hono's own refusals (a malformed JSON body is a 400) keep their status.
  if (e instanceof HTTPException && e.status < 500) return { ...problem(e.status, e.message), instance };
  return {
    type: 'https://swarmy.dev/problems/internal_server_error',
    title: 'Internal Server Error',
    status: 500,
    detail: e instanceof Error ? e.message : 'Unexpected error',
    instance,
  };
}

/** Build a problem body for an explicit status (e.g. auth middleware). */
export function problem(status: number, detail: string, swarmyCode?: string): Problem {
  return {
    type: `https://swarmy.dev/problems/${(TITLES[status] ?? 'error').toLowerCase().replace(/\s+/g, '_')}`,
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    swarmy_code: swarmyCode,
  };
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export type ProblemStatus = ContentfulStatusCode;
