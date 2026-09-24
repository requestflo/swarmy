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
}
export const stacks = kvTable<StackDoc>('stack', { defaults: () => ({ ingressDriver: null }), unique: [['name']] });

export interface RegistryConfigDoc {
  enabled: boolean;
  host: string | null;
  credentialsEnc: string | null;
  requireSignedImages: boolean;
  blockCriticalCves: boolean;
  cosignPublicKey: string | null;
  cosignPrivateKeyEnc: string | null;
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
  }),
});

export interface ImageGcPolicyDoc {
  /** ImageGcMode enum value. */
  mode: string;
  keepProd: boolean;
  days: number | null;
  /** Registry build cache: drop a cache ref no build has written for this many days. */
  cacheMaxAgeDays: number;
  /** Registry build cache: total budget; the least recently written refs go first. */
  cacheMaxGb: number;
}
export const imageGcPolicies = kvTable<ImageGcPolicyDoc>('image-gc', {
  singleton: true,
  defaults: () => ({ mode: 'ON_HEALTHCHECK', keepProd: true, days: null, cacheMaxAgeDays: 14, cacheMaxGb: 20 }),
});
