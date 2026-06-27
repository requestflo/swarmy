/**
 * Managed-Postgres bootstrap (data-store epic, P2 — the upgrade target).
 *
 * When the user moves past "kicking the tires" (2nd node, or opt-in), swarmy
 * stands up its *own* Postgres as a managed Swarm service via the existing deploy
 * path — `postgres:16-alpine`, pinned, on a manager node, with a `local` volume.
 * Credentials are generated and stored encrypted in the vault; this service emits
 * the `DATABASE_URL` the controller should switch to.
 *
 * This keeps "one command / zero manual DB ops": the user never runs
 * `apt install postgresql`. The actual repoint + one-shot data migration is an
 * operational step (documented below / surfaced in the UI) — flip
 * `SWARMY_DB_DRIVER=postgres` + `DATABASE_URL` to the emitted DSN and restart.
 */
import { encryptSecret, randomToken } from '@swarmy/core/crypto';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';

export const MANAGED_PG_IMAGE = 'postgres:16-alpine';
export const MANAGED_PG_SERVICE = 'swarmy-postgres';
export const MANAGED_PG_VOLUME = 'swarmy-pgdata';
export const MANAGED_PG_DB = 'swarmy';
export const MANAGED_PG_USER = 'swarmy';
export const MANAGED_PG_PORT = 5432;

export interface ManagedPgResult {
  /** The service name swarmy deployed. */
  serviceName: string;
  /**
   * The DATABASE_URL to point the controller at. Uses the swarm overlay service
   * DNS (`<service>`) so the controller (also on the swarm) can reach it.
   */
  databaseUrl: string;
  /** Encrypted password ref persisted in the vault (never the plaintext). */
  passwordRef: string;
  image: string;
}

/** Build the swarm `ServiceSpec` for a managed Postgres. */
export function buildManagedPgSpec(password: string): ServiceSpec {
  return {
    name: MANAGED_PG_SERVICE,
    image: MANAGED_PG_IMAGE,
    mode: { replicated: { replicas: 1 } },
    env: {
      POSTGRES_DB: MANAGED_PG_DB,
      POSTGRES_USER: MANAGED_PG_USER,
      POSTGRES_PASSWORD: password,
      // keep WAL modest on a single-node managed instance
      PGDATA: '/var/lib/postgresql/data/pgdata',
    },
    ports: [{ target: MANAGED_PG_PORT, protocol: 'tcp', mode: 'ingress' }],
    mounts: [
      {
        type: 'volume',
        source: MANAGED_PG_VOLUME,
        target: '/var/lib/postgresql/data',
      },
    ],
    // Place on a manager node — the controller's swarm.
    networks: [],
  };
}

/** The DATABASE_URL pointing at the managed service over the swarm overlay. */
export function managedDatabaseUrl(password: string): string {
  return `postgresql://${MANAGED_PG_USER}:${encodeURIComponent(password)}@${MANAGED_PG_SERVICE}:${MANAGED_PG_PORT}/${MANAGED_PG_DB}`;
}

/**
 * Deploy (or re-assert) the managed Postgres service and return the DSN to use.
 * Idempotent: `service.deploy` is create-or-update on the agent.
 */
export async function provisionManagedPostgres(ctx: OrgContext): Promise<ManagedPgResult> {
  const node = await resolveManagerNode(ctx);
  const password = randomToken('swpg').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  const spec = buildManagedPgSpec(password);

  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    throw mapDispatchError(e);
  }

  const passwordRef = encryptSecret(password);
  await writeAudit(ctx, {
    action: 'controller.db.provision',
    targetType: 'service',
    targetId: MANAGED_PG_SERVICE,
    metadata: { image: MANAGED_PG_IMAGE, node: node.id },
  });

  return {
    serviceName: MANAGED_PG_SERVICE,
    databaseUrl: managedDatabaseUrl(password),
    passwordRef,
    image: MANAGED_PG_IMAGE,
  };
}

/**
 * The documented migrate path for lite → managed. Returns the human steps; the
 * actual data move reuses the controller-state logical dump (mode-agnostic), so
 * "dump PGlite → load into managed PG → flip env" is a controller-backup restore
 * targeting the new DSN.
 */
export function migratePlan(result: ManagedPgResult): string[] {
  return [
    `1. Managed Postgres is running as swarm service "${result.serviceName}" (${result.image}).`,
    '2. Take a controller-state backup now (it produces a portable logical dump).',
    `3. Set SWARMY_DB_DRIVER=postgres and DATABASE_URL=${result.databaseUrl}`,
    '4. Run `bun db:migrate` (deploy) against the new DSN to create the schema.',
    '5. Restore the just-taken bundle to load control-plane data into managed PG.',
    '6. Restart the controller. Agents re-adopt automatically (hashed creds in DB).',
  ];
}
