/**
 * Apps & registry config repositories — swarm-kv (P4 slice 4).
 *
 *  - `stack/<id>`      Stack: the user's compose source (its input artifact) +
 *                      ingress driver. Live status/membership derive from Docker.
 *                      Retained versions double as "undo my last compose edit".
 *  - `registry/<orgId>` RegistryConfig (cosign private key stays a vault blob)
 *  - `image-gc/<orgId>` ImageGcPolicy (incl. the build-cache GC budget)
 */
import { kvTable } from './kv-repo';

export interface StackDoc {
  name: string;
  composeSource: string;
  /** IngressDriver enum value, or null. */
  ingressDriver: string | null;
  /**
   * The stack's variables as `.env` text (the bulk `.env` editor's format) —
   * the values compose `${VAR}` interpolation reads, like the `.env` next to a
   * `docker stack deploy`. Null = none. See `interpolateCompose`.
   */
  envSource?: string | null;
}
export const stacks = kvTable<StackDoc>('stack', {
  defaults: () => ({ ingressDriver: null, envSource: null }),
  unique: [['name']],
});

export interface RegistryConfigDoc {
  enabled: boolean;
  host: string | null;
  credentialsEnc: string | null;
  requireSignedImages: boolean;
  blockCriticalCves: boolean;
  cosignPublicKey: string | null;
  cosignPrivateKeyEnc: string | null;
  /** Docker Hub login for the pull-through cache (lifts the anonymous rate limit). */
  cacheUsername?: string | null;
  /** Docker secret holding that login's password/token (the value never lands here). */
  cacheSecret?: string | null;
  /** Public cosign keys (besides the org's own) whose signatures count as signed. Additive. */
  trustedKeys?: { name: string; publicKey: string }[];
}
export const registryConfigs = kvTable<RegistryConfigDoc>('registry', {
  singleton: true,
  defaults: () => ({
    enabled: false,
    host: null,
    credentialsEnc: null,
    requireSignedImages: false,
    blockCriticalCves: false,
    cosignPublicKey: null,
    cosignPrivateKeyEnc: null,
    cacheUsername: null,
    cacheSecret: null,
  }),
});

export interface ImageGcPolicyDoc {
  /** ImageGcMode enum value: ON_HEALTHCHECK | AGE_DAYS | KEEP_LAST. */
  mode: string;
  keepProd: boolean;
  days: number | null;
  /** KEEP_LAST: newest builds kept per repo (absent on docs written before the mode existed). */
  keepLast?: number | null;
  /** Registry build cache: drop a cache ref no build has written for this many days. */
  cacheMaxAgeDays: number;
  /** Registry build cache: total budget; the least recently written refs go first. */
  cacheMaxGb: number;
}
export const imageGcPolicies = kvTable<ImageGcPolicyDoc>('image-gc', {
  singleton: true,
  defaults: () => ({ mode: 'ON_HEALTHCHECK', keepProd: true, days: null, cacheMaxAgeDays: 14, cacheMaxGb: 20 }),
});
