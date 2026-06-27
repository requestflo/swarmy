import type { Problem } from './models.js';

/**
 * Error thrown for any non-2xx response. Carries the parsed RFC 9457
 * `application/problem+json` body when the server provides one.
 */
export class SwarmyApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Parsed problem document (best-effort). */
  readonly problem: Problem;
  /** swarmy-specific machine code, if present (`problem.swarmy_code`). */
  readonly code: string | undefined;

  constructor(status: number, problem: Problem) {
    super(problem.detail ?? problem.title ?? `swarmy API error ${status}`);
    this.name = 'SwarmyApiError';
    this.status = status;
    this.problem = problem;
    this.code = problem.swarmy_code;
    Object.setPrototypeOf(this, SwarmyApiError.prototype);
  }
}
