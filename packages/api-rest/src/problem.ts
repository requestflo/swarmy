/**
 * RFC 9457 problem+json mapping. The services layer throws `TRPCError`s carrying
 * a `swarmyCode` (see `@swarmy/trpc/errors`). One mapper keeps both front doors
 * (tRPC + REST) consistent: tRPC code → HTTP status, `swarmyCode` carried through.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Structural shape of a `TRPCError` (we avoid a direct `@trpc/server` dep here —
 * the services layer throws these and they cross the package boundary as values).
 */
interface TRPCErrorLike {
  name: 'TRPCError';
  code: string;
  message: string;
  cause?: { swarmyCode?: string };
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

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  swarmy_code?: string;
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
    return {
      type: `https://swarmy.dev/problems/${e.code.toLowerCase()}`,
      title: TITLES[status] ?? 'Error',
      status,
      detail: e.message,
      instance,
      swarmy_code: e.cause?.swarmyCode,
    };
  }
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
