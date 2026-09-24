/**
 * In-process first-boot bootstrap for a self-hosted controller.
 *
 * Why in-process (not a separate `docker run` one-shot): it runs right after the
 * boot-time schema bring-up, against the controller's own control.db, before
 * anything else reads it, and needs no extra container, secrets or volume mount.
 *
 * Gated on SWARMY_BOOTSTRAP=1 (set only by the self-host stack) and fully idempotent,
 * so the long-running service re-runs it harmlessly on every restart, and dev (which
 * never sets the flag) is untouched.
 *
 * The installer hands us, via env + Docker secrets (expanded by docker-entrypoint.sh):
 *   ADMIN_EMAIL, ADMIN_PASSWORD             — the first owner login. ADMIN_USERNAME
 *                                             may replace (or accompany) ADMIN_EMAIL:
 *                                             email is optional on swarmy.
 *   SWARMY_BOOTSTRAP_JOIN_TOKEN             — raw join token; the installer keeps the
 *                                             same value to enrol node #1, we store only
 *                                             its hash (so no cross-language hashing risk)
 *   SWARM_ID, SWARM_MANAGER_ADDR,
 *   SWARM_WORKER_TOKEN, SWARM_MANAGER_TOKEN — captured from `docker swarm init`. Primed into the
 *                                             in-memory join cache on every boot (never the DB:
 *                                             swarm state is Docker truth) so a SECOND box JOINS
 *                                             this swarm even before node #1's agent has dialled
 *                                             in. Once it has, joins read fresh tokens from it.
 *   SWARMY_MESH_DRIVER, SWARMY_MESH_MANAGEMENT_URL,
 *   SWARMY_MESH_SERVICE_TOKEN                — from the installer's mesh wizard, when the operator
 *                                             opts into mesh. Skipped entirely when unset (mesh
 *                                             stays opt-in for self-host too).
 *   SWARMY_DASHBOARD_DOMAIN                  — the https dashboard domain (on a public-IP box the
 *                                             installer defaults it to swarmy.<ip-dashed>.sslip.io).
 *                                             Bound to the bootstrap org's ingress settings so its
 *                                             Caddy edge serves a `dashboard` controller vhost.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auth, usernamePlaceholderEmail } from '@swarmy/auth';
import { decryptSecret, encryptSecret, hashToken } from '@swarmy/core/crypto';
import { buildMeshConfigRow } from '@swarmy/core/mesh-bootstrap';
import { prisma } from '@swarmy/db';
import { ingressConfigRepo, meshConfigRepo, primeSwarmJoinMaterial } from '@swarmy/trpc';
import { hub } from '../gateway';

const ORG_NAME = process.env.SWARMY_ORG_NAME ?? 'swarmy';
const ORG_SLUG = process.env.SWARMY_ORG_SLUG ?? 'swarmy';

function log(m: string): void {
  // eslint-disable-next-line no-console
  console.log(`[bootstrap] ${m}`);
}

export async function maybeBootstrapSeed(): Promise<void> {
  if (process.env.SWARMY_BOOTSTRAP !== '1') return;

  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase() || undefined;
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || (username ? usernamePlaceholderEmail(username) : undefined);
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    log('SWARMY_BOOTSTRAP=1 but ADMIN_EMAIL (or ADMIN_USERNAME) / ADMIN_PASSWORD are unset — skipping admin seed.');
    return;
  }

  const orgId = await ensureOrg();
  const userId = await ensureOwner(email, password, username);
  await ensureMembership(orgId, userId);

  const rawToken = process.env.SWARMY_BOOTSTRAP_JOIN_TOKEN;
  if (rawToken) await ensureJoinToken(orgId, userId, rawToken);

  primeSwarmJoin(orgId);
  await ensureMeshConfig(orgId);
  await ensureDashboardDomain(orgId);

  log(`bootstrap complete — org "${ORG_NAME}", owner ${username ?? email}.`);
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

async function ensureOwner(email: string, password: string, username?: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return existing.id;
  // Better Auth owns password hashing + the linked `account` row (and, via the
  // username plugin, the unique username).
  await auth.api.signUpEmail({
    body: { email, password, name: username ?? (email.split('@')[0] || 'admin'), ...(username ? { username } : {}) },
  });
  const created = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!created) throw new Error('bootstrap: user sign-up reported success but no user row found');
  log(`created owner user ${username ?? email}.`);
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
const BOOTSTRAP_TOKEN_MAX_USES = 5;
const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
      // Enrols node #1 and covers the first few nodes the installer's "Add a
      // node" hint is pasted onto. The installer prints it to a terminal, so
      // it must not stay a live credential: agents reconnect with their own
      // stored session afterwards, and later nodes use a dashboard token.
      maxUses: BOOTSTRAP_TOKEN_MAX_USES,
      expiresAt: new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS),
      createdById: userId,
    },
  });
  log('stored bootstrap join token.');
}

/**
 * Prime the in-memory swarm join cache with the installer's `docker swarm init`
 * tokens so additional nodes JOIN this swarm rather than forming a rival one,
 * even before node #1's agent reconnects. Nothing is written to the database.
 */
function primeSwarmJoin(orgId: string): void {
  const worker = process.env.SWARM_WORKER_TOKEN;
  const manager = process.env.SWARM_MANAGER_TOKEN;
  if (!worker && !manager) return;
  primeSwarmJoinMaterial({
    orgId,
    swarmId: process.env.SWARM_ID || null,
    managerAddr: process.env.SWARM_MANAGER_ADDR || null,
    workerToken: worker || null,
    managerToken: manager || null,
  });
  log('primed the swarm join cache so added nodes join this swarm.');
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
  const managed = managedMeshFromEnv();

  whenSwarmReady(`mesh bootstrap (${row.driver}${managed ? ', managed by swarmy' : ''})`, async () => {
    const cur = await meshConfigRepo.find({ hub, db: prisma }, orgId);
    const curCp = (cur?.controlPlane ?? {}) as { serviceTokenEnc?: string; mode?: string; managed?: Record<string, unknown> };
    const curToken = curCp.serviceTokenEnc;
    const same =
      cur &&
      cur.driver === row.driver &&
      cur.enabled &&
      cur.managementUrl === row.managementUrl &&
      curToken !== undefined &&
      safeDecrypt(curToken) === process.env.SWARMY_MESH_SERVICE_TOKEN &&
      (!managed || (curCp.mode === 'managed-by-swarmy' && curCp.managed));
    if (same) return; // re-sealing the same token each boot would only churn raft
    const controlPlane: Record<string, unknown> = managed
      ? {
          ...row.controlPlane,
          mode: 'managed-by-swarmy',
          // What the reconcile learnt later (connector, backups, node id) survives a re-seed.
          managed: { ...managed, ...(curCp.mode === 'managed-by-swarmy' ? (curCp.managed ?? {}) : {}) },
        }
      : (row.controlPlane as Record<string, unknown>);
    await meshConfigRepo.update({ hub, db: prisma }, orgId, {
      driver: row.driver,
      enabled: true,
      managementUrl: row.managementUrl,
      controlPlane,
    });
    log(`persisted MeshConfig (${row.driver}${managed ? `, control plane in swarmy at ${managed.meshDomain}` : ''}) — mesh enabled for this org.`);
  });
}

/**
 * `install-swarmy.sh --mesh swarmy`: the installer started NetBird itself
 * (swarmy-mesh-control on node #1) and hands the controller what it needs to
 * keep running it — the mesh domain + TLS mode, the cluster slug, the node
 * that hosts it, and (secret file, JSON) the relay authSecret, the store
 * encryptionKey and the break-glass owner. Everything secret is sealed with
 * encryptSecret before it reaches swarm-kv.
 */
function managedMeshFromEnv(): Record<string, unknown> | null {
  if (process.env.SWARMY_MESH_MODE !== 'managed-by-swarmy') return null;
  const domain = process.env.SWARMY_MESH_DOMAIN?.trim().toLowerCase();
  const file = process.env.SWARMY_MESH_CONTROL_FILE;
  if (!domain || !file) {
    log('SWARMY_MESH_MODE=managed-by-swarmy but SWARMY_MESH_DOMAIN / SWARMY_MESH_CONTROL_FILE are unset — treating the mesh as external.');
    return null;
  }
  let secrets: { authSecret?: string; encryptionKey?: string; ownerEmail?: string; ownerPassword?: string; extraCaPem?: string };
  try {
    secrets = JSON.parse(readFileSync(file, 'utf8')) as typeof secrets;
  } catch (e) {
    log(`could not read ${file}: ${e instanceof Error ? e.message : String(e)} — treating the mesh as external.`);
    return null;
  }
  if (!secrets.authSecret || !secrets.encryptionKey) {
    log('the mesh control secret is missing authSecret/encryptionKey — treating the mesh as external.');
    return null;
  }
  const tlsRaw = process.env.SWARMY_MESH_TLS ?? 'letsencrypt';
  const tls = tlsRaw.startsWith('none')
    ? { mode: 'none', port: Number(tlsRaw.split(':')[1] ?? 8081) || 8081 }
    : tlsRaw.startsWith('edge')
      ? { mode: 'edge', listen: tlsRaw.split('=')[1] ?? '172.18.0.1:8081' }
      : { mode: 'letsencrypt' };
  return {
    cluster: (process.env.SWARMY_MESH_CLUSTER || ORG_SLUG).toLowerCase(),
    meshDomain: domain,
    tls,
    controlNodeHostname: process.env.SWARMY_MESH_CONTROL_HOSTNAME || process.env.SWARMY_NODE_HOSTNAME || undefined,
    ...(process.env.SWARMY_MESH_ADMIN_URL ? { adminUrl: process.env.SWARMY_MESH_ADMIN_URL } : {}),
    authSecretEnc: encryptSecret(secrets.authSecret),
    encryptionKeyEnc: encryptSecret(secrets.encryptionKey),
    ...(secrets.ownerEmail ? { ownerEmail: secrets.ownerEmail } : {}),
    ...(secrets.ownerPassword ? { ownerPasswordEnc: encryptSecret(secrets.ownerPassword) } : {}),
    ...(secrets.extraCaPem ? { extraCaPem: secrets.extraCaPem } : {}),
  };
}

function safeDecrypt(blob: string): string | null {
  try {
    return decryptSecret(blob);
  } catch {
    return null;
  }
}

/**
 * Boot-time config that lives in the org's swarm (swarm-kv) can only be
 * written once a manager agent has dialled in. Retry until then (logged, not
 * silent); the writes are idempotent re-assertions of env.
 */
function whenSwarmReady(what: string, fn: () => Promise<void>, everyMs = 5_000): void {
  let warned = false;
  const attempt = (): void => {
    fn().catch((e: unknown) => {
      if (!warned) {
        log(`${what}: waiting for a manager agent (${e instanceof Error ? e.message : String(e)})`);
        warned = true;
      }
      setTimeout(attempt, everyMs).unref?.();
    });
  };
  attempt();
}

/**
 * Bind the installer's https dashboard domain to the bootstrap org's ingress
 * settings (`settings.dashboardDomain`), so that org's Caddy edge renders a
 * `dashboard` controller vhost for it (ingress.service computeControllerVhosts).
 * Re-asserted on EVERY boot from env, so an org ingress settings edit can never
 * lose it; env unset (installer `--no-https`) clears it. The org's ingress
 * document (swarm-kv) starts from the service default (Caddy, enabled) when it
 * has none yet; an existing driver choice is kept.
 */
async function ensureDashboardDomain(orgId: string): Promise<void> {
  const domain = process.env.SWARMY_DASHBOARD_DOMAIN?.trim().toLowerCase() || null;
  whenSwarmReady('dashboard domain', async () => {
    let changed = false;
    await ingressConfigRepo.update({ hub, db: prisma }, orgId, (cur) => {
      const settings = { ...cur.settings };
      if ((settings.dashboardDomain ?? null) === domain) return undefined;
      if (domain) settings.dashboardDomain = domain;
      else delete settings.dashboardDomain;
      changed = true;
      return { settings };
    });
    if (changed) log(domain ? `dashboard domain ${domain} bound to the org edge.` : 'dashboard domain cleared.');
  });
}
