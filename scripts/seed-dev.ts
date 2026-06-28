// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Idempotent local-dev seed: get the controller from zero to a usable swarm.
 *
 * Creates (or reuses):
 *   - a login user           dev@swarmy.local / swarmy-dev  (via Better Auth)
 *   - an Organization        "Swarmy Dev"
 *   - an owner Member        (the dev user)
 *   - ONE JoinToken          minted exactly like nodes.generateJoinToken so its
 *                            sha256 hash matches what the gateway verifies.
 *
 * The RAW join token is written to `.swarmy-dev-token` (gitignored) and printed,
 * together with the login creds and the `bun run dev:agent` next step.
 *
 * The active org is selected at sign-in time by the session create hook in
 * @swarmy/auth, so this seed only has to make the membership exist.
 *
 * Run with the repo-root env loaded (so DATABASE_URL + BETTER_AUTH_SECRET reach
 * Prisma and Better Auth):
 *   bun --env-file=.env run scripts/seed-dev.ts
 *   (wired as `bun run seed-dev`).
 *
 * Usage: bun run seed-dev
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@swarmy/db';
import { auth } from '@swarmy/auth';
import { JOIN_TOKEN_PREFIX } from '@swarmy/core';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = join(repoRoot, '.swarmy-dev-token');

const DEV_EMAIL = 'dev@swarmy.local';
const DEV_PASSWORD = 'swarmy-dev';
const DEV_NAME = 'Swarmy Dev';
const ORG_NAME = 'Swarmy Dev';
const ORG_SLUG = 'swarmy-dev';

// Match the gateway's verification scheme exactly (apps/api gateway uses
// sha256(rawToken).hex; token.service mints `${JOIN_TOKEN_PREFIX}_${prefix}_${secret}`).
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function fail(msg: string): never {
  console.error(`seed-dev: ${msg}`);
  process.exit(1);
}

async function ensureUser(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email: DEV_EMAIL }, select: { id: true } });
  if (existing) {
    console.log(`seed-dev: user ${DEV_EMAIL} already exists (reusing).`);
    return existing.id;
  }
  // Better Auth owns password hashing + the `account` row; go through its API
  // rather than writing the user table directly.
  try {
    await auth.api.signUpEmail({ body: { email: DEV_EMAIL, password: DEV_PASSWORD, name: DEV_NAME } });
  } catch (err) {
    fail(
      `failed to create dev user via Better Auth: ${err instanceof Error ? err.message : String(err)}\n` +
        '  Is BETTER_AUTH_SECRET set to a real value and DATABASE_URL reachable?',
    );
  }
  const created = await prisma.user.findUnique({ where: { email: DEV_EMAIL }, select: { id: true } });
  if (!created) fail('user creation reported success but no user row found');
  console.log(`seed-dev: created login user ${DEV_EMAIL}.`);
  return created.id;
}

async function ensureOrg(): Promise<string> {
  const existing = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } });
  if (existing) {
    console.log(`seed-dev: organization "${ORG_NAME}" already exists (reusing).`);
    return existing.id;
  }
  const org = await prisma.organization.create({
    data: { id: crypto.randomUUID(), name: ORG_NAME, slug: ORG_SLUG },
    select: { id: true },
  });
  console.log(`seed-dev: created organization "${ORG_NAME}".`);
  return org.id;
}

async function ensureMember(orgId: string, userId: string): Promise<void> {
  const existing = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { id: true },
  });
  if (existing) {
    console.log('seed-dev: owner membership already exists (reusing).');
    return;
  }
  await prisma.member.create({
    data: { id: crypto.randomUUID(), organizationId: orgId, userId, role: 'owner' },
  });
  console.log('seed-dev: added dev user as owner.');
}

/**
 * Mint a join token only if no usable one already exists, so re-runs don't churn
 * a new token (and rewrite `.swarmy-dev-token`) on every invocation. Returns the
 * raw token when freshly minted, or null when an existing token is reused.
 */
async function ensureJoinToken(orgId: string, userId: string): Promise<string | null> {
  const usable = await prisma.joinToken.findFirst({
    where: {
      orgId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, maxUses: true, uses: true },
    orderBy: { createdAt: 'desc' },
  });
  if (usable && (usable.maxUses == null || usable.uses < usable.maxUses)) {
    console.log('seed-dev: a usable join token already exists; keeping .swarmy-dev-token as-is.');
    console.log('seed-dev: to force a fresh token, delete .swarmy-dev-token and revoke the old one in the dashboard.');
    return null;
  }

  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${JOIN_TOKEN_PREFIX}_${prefix}_${secret}`;
  // Generous local TTL + multi-use so a laptop session can re-register freely.
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await prisma.joinToken.create({
    data: {
      orgId,
      tokenHash: hashToken(token),
      tokenPrefix: prefix,
      label: 'dev (seed-dev)',
      maxUses: 100,
      expiresAt,
      createdById: userId,
    },
  });
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  console.log('seed-dev: minted a join token and wrote .swarmy-dev-token (gitignored).');
  return token;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn('seed-dev: DATABASE_URL not set; Prisma will fall back to localhost:5678 (run via `bun run seed-dev`).');
  }

  const userId = await ensureUser();
  const orgId = await ensureOrg();
  await ensureMember(orgId, userId);
  const minted = await ensureJoinToken(orgId, userId);

  console.log('');
  console.log('  Local swarm is seeded. Next steps:');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  1. Start the controller + dashboard:   bun dev`);
  console.log(`  2. In a second terminal, start a node:  bun run dev:agent`);
  console.log(`  3. Open http://localhost:3003 and log in:`);
  console.log(`       email:    ${DEV_EMAIL}`);
  console.log(`       password: ${DEV_PASSWORD}`);
  console.log(`     Your node appears ONLINE on the Infrastructure plane.`);
  console.log('');
  if (minted) {
    console.log(`  Join token (also saved to .swarmy-dev-token):`);
    console.log(`    ${minted}`);
    console.log('');
    console.log('  Onboard a REMOTE box with the same one-liner the dashboard mints:');
    console.log(`    curl -fsSL http://localhost:3001/install.sh | SWARMY_JOIN_TOKEN=${minted} sh`);
  } else {
    console.log('  Reusing the existing join token in .swarmy-dev-token (if present).');
  }
  console.log('');
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => prisma.$disconnect().catch(() => undefined));
