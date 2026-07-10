/**
 * In-process first-boot bootstrap for a self-hosted controller (lite + standard).
 *
 * Why in-process (not a separate `docker run` one-shot): in lite (PGlite) mode the
 * database is embedded in THIS controller process — a single, exclusive connection
 * with no TCP endpoint — so nothing outside the process can seed it. Running the
 * seed here covers both tiers with one code path.
 *
 * Gated on SWARMY_BOOTSTRAP=1 (set only by the self-host stack) and fully idempotent,
 * so the long-running service re-runs it harmlessly on every restart, and dev (which
 * never sets the flag) is untouched.
 *
 * The installer hands us, via env + Docker secrets (expanded by docker-entrypoint.sh):
 *   ADMIN_EMAIL, ADMIN_PASSWORD             — the first owner login
 *   SWARMY_BOOTSTRAP_JOIN_TOKEN             — raw join token; the installer keeps the
 *                                             same value to enrol node #1, we store only
 *                                             its hash (so no cross-language hashing risk)
 *   SWARM_ID, SWARM_MANAGER_ADDR,
 *   SWARM_WORKER_TOKEN, SWARM_MANAGER_TOKEN — captured from `docker swarm init`, persisted
 *                                             as SwarmConfig so a SECOND box JOINS this swarm
 *                                             instead of forming a rival. (orchestrateSwarmMembership
 *                                             short-circuits the SwarmConfig write for a manager
 *                                             that is already in a swarm — swarm.service.ts — so
 *                                             a directly-`docker swarm init`'d host never persists
 *                                             its join tokens. We persist them here.)
 *   SWARMY_MESH_DRIVER, SWARMY_MESH_MANAGEMENT_URL,
 *   SWARMY_MESH_SERVICE_TOKEN                — from the installer's mesh wizard, when the operator
 *                                             opts into mesh. Skipped entirely when unset (mesh
 *                                             stays opt-in for self-host too).
 */
import { randomUUID } from 'node:crypto';
import { auth } from '@swarmy/auth';
import { encryptSecret, hashToken } from '@swarmy/core/crypto';
import { buildMeshConfigRow } from '@swarmy/core/mesh-bootstrap';
import { prisma } from '@swarmy/db';

const ORG_NAME = process.env.SWARMY_ORG_NAME ?? 'swarmy';
const ORG_SLUG = process.env.SWARMY_ORG_SLUG ?? 'swarmy';

function log(m: string): void {
  // eslint-disable-next-line no-console
  console.log(`[bootstrap] ${m}`);
}

export async function maybeBootstrapSeed(): Promise<void> {
  if (process.env.SWARMY_BOOTSTRAP !== '1') return;

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    log('SWARMY_BOOTSTRAP=1 but ADMIN_EMAIL/ADMIN_PASSWORD are unset — skipping admin seed.');
    return;
  }

  const orgId = await ensureOrg();
  const userId = await ensureOwner(email, password);
  await ensureMembership(orgId, userId);

  const rawToken = process.env.SWARMY_BOOTSTRAP_JOIN_TOKEN;
  if (rawToken) await ensureJoinToken(orgId, userId, rawToken);

  await ensureSwarmConfig(orgId);
  await ensureMeshConfig(orgId);

  log(`bootstrap complete — org "${ORG_NAME}", owner ${email}.`);
}

async function ensureOrg(): Promise<string> {
  const existing = await prisma.organization.findUnique({
    where: { slug: ORG_SLUG },
    select: { id: true },
  });
  if (existing) return existing.id;
  const org = await prisma.organization.create({
    data: { id: randomUUID(), name: ORG_NAME, slug: ORG_SLUG },
    select: { id: true },
  });
  log(`created organization "${ORG_NAME}".`);
  return org.id;
}

async function ensureOwner(email: string, password: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return existing.id;
  // Better Auth owns password hashing + the linked `account` row.
  await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0] || 'admin' } });
  const created = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!created) throw new Error('bootstrap: user sign-up reported success but no user row found');
  log(`created owner user ${email}.`);
  return created.id;
}

async function ensureMembership(orgId: string, userId: string): Promise<void> {
  const existing = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { id: true },
  });
  if (existing) return;
  await prisma.member.create({
    data: { id: randomUUID(), organizationId: orgId, userId, role: 'owner' },
  });
  log('added owner membership.');
}

/**
 * Persist the installer-minted join token. We store only its hash (the gateway
 * verifies presented tokens the same way), and parse the display prefix from the
 * `swt_<prefix>_<secret>` shape. Idempotent on the hash so restarts don't churn rows.
 */
async function ensureJoinToken(orgId: string, userId: string, raw: string): Promise<void> {
  const tokenHash = hashToken(raw);
  const existing = await prisma.joinToken.findUnique({ where: { tokenHash }, select: { id: true } });
  if (existing) return;
  const parts = raw.split('_');
  const tokenPrefix = parts.length >= 3 ? parts[1]! : raw.slice(0, 8);
  await prisma.joinToken.create({
    data: {
      orgId,
      tokenHash,
      tokenPrefix,
      label: 'self-host bootstrap',
      // Long-lived + multi-use so the operator can add nodes; revocable in the dashboard.
      maxUses: 100,
      expiresAt: null,
      createdById: userId,
    },
  });
  log('stored bootstrap join token.');
}

/**
 * Record the swarm's join tokens so additional nodes JOIN this swarm rather than
 * forming a rival one. Mirrors the row shape written by swarm.service.ts, encrypting
 * the Docker `SWMTKN-…` tokens with the vault key.
 */
async function ensureSwarmConfig(orgId: string): Promise<void> {
  const worker = process.env.SWARM_WORKER_TOKEN;
  const manager = process.env.SWARM_MANAGER_TOKEN;
  if (!worker && !manager) return;
  const row = {
    orgId,
    swarmId: process.env.SWARM_ID || null,
    managerAddr: process.env.SWARM_MANAGER_ADDR || null,
    workerJoinTokenEnc: worker ? encryptSecret(worker) : null,
    managerJoinTokenEnc: manager ? encryptSecret(manager) : null,
  };
  await prisma.swarmConfig.upsert({ where: { orgId }, create: row, update: row });
  log('persisted SwarmConfig (join tokens) so added nodes join this swarm.');
}

/**
 * Enable mesh for the bootstrap org when the installer wizard collected NetBird
 * Cloud (or another driver's) management URL + service token. Skips entirely
 * when unset — self-host stays mesh-opt-in, same as every other onboarding path
 * (epic: zero-trust-networking). Row shape (and validation) is shared with
 * scripts/seed-dev.ts via @swarmy/core/mesh-bootstrap so the `controlPlane`
 * JSON stays in sync with what mesh.service.ts's `toOrgConfig` expects.
 */
async function ensureMeshConfig(orgId: string): Promise<void> {
  const row = buildMeshConfigRow(orgId, {
    driver: process.env.SWARMY_MESH_DRIVER,
    managementUrl: process.env.SWARMY_MESH_MANAGEMENT_URL,
    serviceToken: process.env.SWARMY_MESH_SERVICE_TOKEN,
    onInvalidDriver: (raw) => log(`SWARMY_MESH_DRIVER="${raw}" is not a recognized driver — skipping mesh bootstrap.`),
  });
  if (!row) return;

  await prisma.meshConfig.upsert({ where: { orgId }, create: row, update: row });
  log(`persisted MeshConfig (${row.driver}) — mesh enabled for this org.`);
}
