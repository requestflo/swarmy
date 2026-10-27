/**
 * Backup/restore/dump sidecars from the in-cluster mirror (air-gapped
 * clusters). A node that joined after install has nothing preloaded, so a
 * helper pulled from upstream fails there. When the system-image mirror is
 * trusted, the hub decorator sends each helper field (`image`, `resticImage`,
 * `clientImage`, `engineImage`) as its mirrored copy
 * (`<registry>/swarmy-system/…:<tag>@sha256:…`), the upstream ref it replaced
 * in the matching fallback field, and the in-swarm registry login in
 * `registryAuth`: the same shape as `container.runOnce`'s `fallbackImage`.
 *
 * The agent pulls the mirrored ref with that login, then the fallback when
 * the mirror can't serve it (`handlers/helper-pull.ts`). Every field here is
 * additive (zod strips unknown keys on an older agent), and the controller
 * only rewrites for an agent that advertises `helperImageMirror`
 * (`capabilities.ts`): an older agent pulls its sidecar without a login, and
 * the registry refuses an anonymous pull.
 */
import { z } from 'zod';
import { RegistryAuth } from './commands';

/** Each helper-image payload field and the field that carries its upstream fallback. */
export const HELPER_FALLBACK_FIELD = {
  image: 'fallbackImage',
  resticImage: 'fallbackResticImage',
  clientImage: 'fallbackClientImage',
  engineImage: 'fallbackEngineImage',
} as const;
export type HelperField = keyof typeof HELPER_FALLBACK_FIELD;

/** Upstream ref to pull when the mirrored helper can't be pulled and isn't on the node. */
const Fallback = z.string().optional();

/** The in-swarm registry login a mirrored helper is pulled with (attached by the hub decorator). */
const helperLogin = { registryAuth: RegistryAuth.optional() };

/** Volume backups, restores and listings (`image` runs restic). */
export const imageFallbackFields = { fallbackImage: Fallback, ...helperLogin };
/** Compose-DB dumps (`resticImage`). */
export const resticFallbackFields = { fallbackResticImage: Fallback, ...helperLogin };
/** wal-g window reads and WAL checks (`engineImage`). */
export const engineFallbackFields = { fallbackEngineImage: Fallback, ...helperLogin };
/** Managed-Postgres backups and restores (restic, the Postgres client, wal-g). */
export const dbHelperFallbackFields = {
  fallbackResticImage: Fallback,
  fallbackClientImage: Fallback,
  fallbackEngineImage: Fallback,
  ...helperLogin,
};
