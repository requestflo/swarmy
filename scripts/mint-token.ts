// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mint a FRESH join token for the local dev org and (over)write
 * `.swarmy-dev-token`. Unlike seed-dev's `ensureJoinToken` (which keeps an
 * existing usable token), this always mints a new one — used by
 * `scripts/local-vms.sh` so a stale/expired `.swarmy-dev-token` never silently
 * blocks node enrollment.
 *
 * When the dev org has mesh enabled (see seed-dev's SWARMY_MESH_DRIVER/
 * SWARMY_NB_MANAGEMENT_URL/SWARMY_NB_SERVICE_TOKEN), also mints a NetBird setup
 * key for this token via mintSetupKeyForOrg — the exact same call
 * token.service.ts's generateJoinToken makes — and forces maxUses=1 (setup
 * keys are single-use). `mintSetupKeyForOrg` only reads ctx.db/ctx.activeOrgId,
 * so a minimal synthetic OrgContext is enough here (see apiKeyContext.ts for
 * the fuller pattern this mirrors).
 *
 * Output is `KEY=value` lines so scripts/local-vms.sh can parse each field
 * independently instead of relying on line position:
 *   TOKEN=swt_...
 *   MESH_SETUP_KEY=...        (only when mesh is enabled for the org)
 *   MESH_MANAGEMENT_URL=...
 *   MESH_DRIVER=netbird
 *
 * Run: bun --env-file=.env run scripts/mint-token.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@swarmy/db';
import { JOIN_TOKEN_PREFIX } from '@swarmy/core';
import { mintSetupKeyForOrg, type OrgContext } from '@swarmy/trpc';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = join(repoRoot, '.swarmy-dev-token');
const ORG_SLUG = 'swarmy-dev';

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } });
if (!org) {
  console.error("mint-token: dev org not found — run 'bun run seed-dev' (or 'bun run dev:up') first.");
  process.exit(1);
}

// mintSetupKeyForOrg only touches ctx.db and ctx.activeOrgId — everything else
// on OrgContext (session/user/hub/auth/membership) is unused on this path.
const meshCtx = { db: prisma, activeOrgId: org.id } as unknown as OrgContext;
const mesh = await mintSetupKeyForOrg(meshCtx);

const prefix = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const token = `${JOIN_TOKEN_PREFIX}_${prefix}_${secret}`;
// NetBird setup keys are single-use — force maxUses=1 whenever one is embedded,
// mirroring token.service.ts's generateJoinToken.
const maxUses = mesh ? 1 : 100;
await prisma.joinToken.create({
  data: {
    orgId: org.id,
    tokenHash: hashToken(token),
    tokenPrefix: prefix,
    label: 'dev (local-vms)',
    maxUses,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  },
});
writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });

process.stdout.write(`TOKEN=${token}\n`);
if (mesh) {
  process.stdout.write(`MESH_SETUP_KEY=${mesh.setupKey}\n`);
  process.stdout.write(`MESH_MANAGEMENT_URL=${mesh.managementUrl ?? ''}\n`);
  process.stdout.write(`MESH_DRIVER=${mesh.driver}\n`);
}
