/**
 * The controller refused this page's origin (Better Auth INVALID_ORIGIN): the
 * dashboard was opened on an address swarmy doesn't know it serves on. Shown
 * inline with where to go instead, never as a bare "Invalid origin" toast.
 */
export class AuthOriginError extends Error {
  constructor(readonly origin: string) {
    super(`Sign-in isn't accepted from ${origin}. swarmy only accepts sign-in from addresses it serves on.`);
    this.name = 'AuthOriginError';
  }
}

/** Better Auth's CSRF origin rejection (`INVALID_ORIGIN`, 403 "Invalid origin"). */
export function isOriginRejection(error: { message?: string; code?: string }): boolean {
  return error.code === 'INVALID_ORIGIN' || /invalid origin/i.test(error.message ?? '');
}
