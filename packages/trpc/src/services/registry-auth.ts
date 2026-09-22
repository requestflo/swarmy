/**
 * In-swarm registry authentication (auto-generated login).
 *
 * The `registry:2` service is published on the routing mesh at :5000 on every
 * node, so without auth anyone who reaches a node's :5000 can push/pull.
 * Enabling the registry therefore auto-generates a login (`swarmy` + a strong
 * random password, encrypted at rest in `RegistryConfig.credentialsEnc`), renders
 * a bcrypt htpasswd delivered as a Docker SECRET (content-addressed name, so a
 * rotation is a new secret + a service update), and turns on registry:2's
 * htpasswd auth. Every legitimate push/pull then carries the creds:
 *  - push: `image.build` `registryAuth` (cicd.service `runBuild`);
 *  - pull: `service.deploy` / `image.pull` get `registryAuth` attached centrally
 *    by the hub dispatch decorator below whenever an image is an org-registry
 *    image — so the swarm stores them (X-Registry-Auth) and every node can pull;
 *  - trivy / cosign runOnce: TRIVY_USERNAME/PASSWORD, `--registry-username/password`.
 *
 * The password never leaves the controller except inside those agent command
 * payloads (JIT, over the authenticated WS) — never to a client.
 */
import { createHash, randomBytes } from 'node:crypto';
import { decryptSecret } from '@swarmy/core/crypto';
import type { RegistryAuth, ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import type { CommandName, DispatchDecorator } from '../hub/types';
import { canonicalRegistryHost, isOrgRegistryImage } from './registryPolicy.service';

export const REGISTRY_SERVICE_NAME = 'swarmy-registry';
export const REGISTRY_IMAGE = 'registry:2';
export const REGISTRY_PORT = 5000;
export const REGISTRY_AUTH_USERNAME = 'swarmy';
export const REGISTRY_AUTH_REALM = 'swarmy-registry';
/** Secret mount target name — lands at `/run/secrets/<name>` in the registry task. */
export const REGISTRY_HTPASSWD_TARGET = 'registry-htpasswd';
export const REGISTRY_HTPASSWD_PATH = `/run/secrets/${REGISTRY_HTPASSWD_TARGET}`;
export const REGISTRY_HTPASSWD_SECRET_PREFIX = 'swarmy-registry-htpasswd-';
/** Service label carrying the htpasswd secret name the registry was deployed with (converge check). */
export const REGISTRY_AUTH_LABEL = 'swarmy.registry.auth';
export const REGISTRY_MANAGED_LABEL = 'swarmy.managed';

export interface RegistryCreds {
  username: string;
  password: string;
}

/** Fresh login: fixed username + 256-bit random password (URL-safe, htpasswd-safe). */
export function generateRegistryCreds(): RegistryCreds {
  return { username: REGISTRY_AUTH_USERNAME, password: randomBytes(32).toString('base64url') };
}

/** Decrypt the stored creds; null when absent or undecryptable. */
export function decodeRegistryCreds(enc: string | null | undefined): RegistryCreds | null {
  if (!enc) return null;
  try {
    const v = JSON.parse(decryptSecret(enc)) as Partial<RegistryCreds>;
    return v.username && v.password ? { username: v.username, password: v.password } : null;
  } catch {
    return null;
  }
}

/** One htpasswd line (`user:$2b$…`). registry:2 only accepts bcrypt. */
export async function renderHtpasswd(creds: RegistryCreds): Promise<string> {
  const hash = await Bun.password.hash(creds.password, { algorithm: 'bcrypt', cost: 10 });
  return `${creds.username}:${hash}\n`;
}

/**
 * Content-addressed secret name, derived from the CREDENTIALS (bcrypt salts make
 * the rendered file non-deterministic): same login → same name (idempotent
 * re-create), rotated login → new name → the registry service updates. The
 * digest of a 256-bit random password reveals nothing useful.
 */
export function htpasswdSecretName(creds: RegistryCreds): string {
  const h = createHash('sha256').update(`${creds.username}:${creds.password}`).digest('hex').slice(0, 16);
  return `${REGISTRY_HTPASSWD_SECRET_PREFIX}${h}`;
}

/** The registry:2 swarm service spec, with htpasswd auth enforced. */
export function registryServiceSpec(secretName: string): ServiceSpec {
  return {
    name: REGISTRY_SERVICE_NAME,
    image: REGISTRY_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: { [REGISTRY_MANAGED_LABEL]: 'true', [REGISTRY_AUTH_LABEL]: secretName },
    env: {
      REGISTRY_AUTH: 'htpasswd',
      REGISTRY_AUTH_HTPASSWD_REALM: REGISTRY_AUTH_REALM,
      REGISTRY_AUTH_HTPASSWD_PATH: REGISTRY_HTPASSWD_PATH,
    },
    secrets: [{ source: secretName, target: REGISTRY_HTPASSWD_TARGET, mode: 0o444 }],
    ports: [{ target: REGISTRY_PORT, published: REGISTRY_PORT, protocol: 'tcp', mode: 'ingress' }],
    networks: ['swarmy'],
    mounts: [{ type: 'volume', source: 'swarmy-registry-data', target: '/var/lib/registry' }],
  };
}

/** Does the LIVE registry service already enforce auth with this exact htpasswd secret? */
export function registryAuthConverged(live: SwarmServiceInfo, secretName: string): boolean {
  return (
    live.labels[REGISTRY_AUTH_LABEL] === secretName &&
    live.env.includes('REGISTRY_AUTH=htpasswd') &&
    live.secrets.includes(secretName)
  );
}

/** Images a dispatch will make a node pull (only the commands that pull). */
export function dispatchImages(cmd: CommandName, payload: unknown): string[] {
  const p = payload as { spec?: { image?: unknown }; image?: unknown } | null | undefined;
  if (cmd === 'service.deploy') return typeof p?.spec?.image === 'string' ? [p.spec.image] : [];
  if (cmd === 'image.pull') return typeof p?.image === 'string' ? [p.image] : [];
  return [];
}

/**
 * Pure: attach the registry creds to a `service.deploy` / `image.pull` payload
 * iff it pulls an org-registry image. Never overrides an explicit
 * `registryAuth`; never touches any other command or a public image.
 */
export function attachRegistryAuth<P>(cmd: CommandName, payload: P, registryHost: string, creds: RegistryCreds): P {
  const images = dispatchImages(cmd, payload);
  if (!images.some((img) => isOrgRegistryImage(img, registryHost))) return payload;
  const p = payload as P & { registryAuth?: RegistryAuth };
  if (p.registryAuth) return payload;
  return {
    ...p,
    registryAuth: { username: creds.username, password: creds.password, server: registryHost },
  };
}

/** Cheap pre-filter: could any image name a registry host (so a DB lookup is worth it)? */
function mayBeRegistryImage(images: string[]): boolean {
  return images.some((img) => {
    const first = img.split('/')[0] ?? '';
    return img.includes('/') && (first.includes(':') || first.includes('.') || first === 'localhost');
  });
}

/**
 * The hub-level hook: EVERY `service.deploy` / `image.pull` dispatch passes
 * through it (apps/api `AgentHubImpl.setDispatchDecorator`), so createService,
 * stacks, autodeploy, promote, previews, canaries and the reconcile workers all
 * carry pull auth without each call site knowing about the registry. Fails open
 * to the undecorated payload (the registry itself still enforces auth).
 */
export function createRegistryAuthDecorator(db: DB): DispatchDecorator {
  return async (orgId, cmd, payload) => {
    const images = dispatchImages(cmd, payload);
    if (!images.length || !mayBeRegistryImage(images)) return payload;
    const row = await db.registryConfig.findUnique({
      where: { orgId },
      select: { host: true, credentialsEnc: true },
    });
    const creds = decodeRegistryCreds(row?.credentialsEnc);
    if (!creds) return payload;
    return attachRegistryAuth(cmd, payload, canonicalRegistryHost(row?.host), creds);
  };
}
