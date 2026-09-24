import { authClient } from '@swarmy/auth/client';

/**
 * Thin wrappers over Better Auth's `/api/auth/two-factor/*` (the twoFactor
 * client plugin) that throw on error, so callers can `try/await` and toast.
 * The same verify calls serve the sign-in challenge (no session yet, the
 * plugin's two-factor cookie), a pending magic-link session, and terminal
 * step-up (live session); the server stamps `session.mfaVerifiedAt` on success.
 */

export type CodeKind = 'totp' | 'backup';

function unwrap<T>(res: { data: T | null; error: { message?: string } | null }, fallback: string): T {
  if (res.error) throw new Error(res.error.message || fallback);
  return res.data as T;
}

export async function verifySecondFactor(code: string, kind: CodeKind): Promise<void> {
  const clean = code.trim();
  const res =
    kind === 'totp'
      ? await authClient.twoFactor.verifyTotp({ code: clean.replace(/\s+/g, '') })
      : await authClient.twoFactor.verifyBackupCode({ code: clean });
  unwrap(res, 'That code did not work.');
}

export async function startEnrolment(password?: string): Promise<{ totpURI: string; backupCodes: string[] }> {
  const res = await authClient.twoFactor.enable(password ? { password } : ({} as { password: string }));
  return unwrap(res, 'Could not start two-factor setup.');
}

export async function regenerateBackupCodes(password?: string): Promise<string[]> {
  const res = await authClient.twoFactor.generateBackupCodes(
    password ? { password } : ({} as { password: string }),
  );
  return unwrap(res, 'Could not generate new backup codes.').backupCodes;
}

export async function disableTwoFactor(password?: string): Promise<void> {
  const res = await authClient.twoFactor.disable(password ? { password } : ({} as { password: string }));
  unwrap(res, 'Could not turn off two-factor.');
}

/** The base32 secret inside an otpauth:// URI, grouped for typing by hand. */
export function secretFromUri(uri: string): string {
  try {
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    return secret.replace(/(.{4})/g, '$1 ').trim();
  } catch {
    return '';
  }
}

/** The swarmyCode a tRPC error carries (see packages/trpc/src/trpc.ts). */
export function swarmyCodeOf(e: unknown): string | undefined {
  return (e as { data?: { swarmyCode?: string } } | null)?.data?.swarmyCode;
}

export const STEP_UP_CODES = ['MFA_STEP_UP_REQUIRED', 'MFA_ENROLMENT_REQUIRED'] as const;
