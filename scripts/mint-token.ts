// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mint a FRESH multi-use join token for the local dev org and (over)write
 * `.swarmy-dev-token`. Unlike seed-dev's `ensureJoinToken` (which keeps an
 * existing usable token), this always mints a new one — used by
 * `scripts/local-vms.sh` so a stale/expired `.swarmy-dev-token` never silently
 * blocks node enrollment.
 *
 * Run: bun --env-file=.env run scripts/mint-token.ts   (prints the raw token)
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@swarmy/db';
import { JOIN_TOKEN_PREFIX } from '@swarmy/core';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = join(repoRoot, '.swarmy-dev-token');
const ORG_SLUG = 'swarmy-dev';

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } });
if (!org) {
  console.error("mint-token: dev org not found — run 'bun run seed-dev' (or 'bun run dev:up') first.");
  process.exit(1);
}

const prefix = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const token = `${JOIN_TOKEN_PREFIX}_${prefix}_${secret}`;
await prisma.joinToken.create({
  data: {
    orgId: org.id,
    tokenHash: hashToken(token),
    tokenPrefix: prefix,
    label: 'dev (local-vms)',
    maxUses: 100,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  },
});
writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
process.stdout.write(`${token}\n`);
