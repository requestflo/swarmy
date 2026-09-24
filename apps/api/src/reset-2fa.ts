/**
 * Locked-out-owner recovery: `bun run reset-2fa --email owner@example.com`
 * (or `--user <username>` for an account without email).
 *
 * Removes the user's authenticator and backup codes, turns 2FA off, and signs
 * them out everywhere, so they can sign in with their password alone and
 * enrol again. Audited as a `system` action (`security.twoFactor.reset`,
 * `via: controller-cli`) in every workspace they belong to.
 *
 * This is deliberately a CLI and not a dashboard button: only someone who can
 * exec into the controller (who therefore already holds its database) can run
 * it. Runbook: docs/ACCOUNT-SECURITY.md.
 *
 *   standard tier:  docker exec -it $(docker ps -q -f name=swarmy_controller) \
 *                     bun run apps/api/src/reset-2fa.ts --email you@example.com
 *   lite tier:      PGlite is single-process, so stop the controller first
 *                   (see the runbook).
 */
import { prisma } from '@swarmy/db';
import { resetTwoFactorByEmail } from '@swarmy/trpc';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

const email = arg('email') ?? arg('user') ?? process.env.SWARMY_RESET_2FA_EMAIL;
if (!email) {
  console.error('usage: bun run reset-2fa --email <user email> | --user <username>');
  process.exit(2);
}

try {
  const res = await resetTwoFactorByEmail(prisma, email);
  if (!res.found) {
    console.error(`no user with email or username ${email}`);
    process.exit(1);
  }
  console.log(
    `two-factor reset for ${email}: authenticator + backup codes removed, all sessions signed out ` +
      `(audited in ${res.orgs} workspace${res.orgs === 1 ? '' : 's'}). Sign in with your password and enrol again.`,
  );
  await prisma.$disconnect?.();
  process.exit(0);
} catch (err) {
  console.error('reset-2fa failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
