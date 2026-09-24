/**
 * PURE — carry swarmy's managed-data wiring across a compose (re)deploy.
 *
 * `deployFromCompose` rebuilds every service spec from the compose file, and
 * a compose file never declares what swarmy's attach flows stamped on the
 * LIVE service afterwards (`injectConnection`, `attachCacheToService`,
 * `attachSearchToService`, `attachVectorToService`, bucket attach, AI gateway
 * attach): the connection env, the secret file mount, the resource's private
 * overlay, and the `swarmy.<domain>.inject*` / `swarmy.s3.*` marker labels.
 * Without this carry, the next deploy silently unwires the app — it loses its
 * `DATABASE_URL` and the network its database lives on.
 *
 * Rules:
 *  - Only a domain whose marker label is on the live service is carried; no
 *    marker → nothing (the spec is returned unchanged, same reference).
 *  - A compose spec that sets the domain's marker label itself wins — the
 *    whole domain is left to the compose.
 *  - Env VALUES come from the live service (they hold passwords/keys minted
 *    once); a key the compose sets itself wins (user intent).
 *  - The attach network is added only when missing; aliases are untouched.
 *  - Secret refs: the exact live refs from `service.inspect` when the caller
 *    passes them ({@link secretRefsFromInspect}); otherwise derived — source
 *    from the domain's secret-name convention (or the `swarmy.s3.secret`
 *    label), target from the carried `*_FILE` env (`/run/secrets/<target>`).
 */
import { STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { AI_BIND_ENV, AI_BIND_LABEL, AI_ENV_VAR, AI_INJECT_KEY_LABEL, AI_INJECT_LABEL, AI_KEY_FILE_VAR, aiKeySecretName } from './ai.service';
import { ATTACH_ENV_KEYS, S3_BUCKET_LABEL, S3_KEY_LABEL, S3_SECRET_LABEL } from './buckets.service';
import {
  CACHE_INJECT_LABEL,
  CACHE_INJECT_VAR_LABEL,
  cacheNetworkName,
  cachePasswordFileVar,
  cachePasswordSecretName,
} from './cache.service';
import { GARAGE_NETWORK } from './garage-render';
import { clusterNetworkName, DB_INJECT_LABEL, DB_INJECT_VAR_LABEL, roVarName } from './manageddb.service';
import { SEARCH_INJECT_LABEL, SEARCH_INJECT_VAR_LABEL, searchKeySecretName, searchNetworkName } from './search.service';
import { VECTOR_INJECT_LABEL, VECTOR_INJECT_VAR_LABEL, vectorKeySecretName, vectorNetworkName } from './vector.service';

type SecretRef = NonNullable<ServiceSpec['secrets']>[number];

export interface CarryExtras {
  /** The live service's exact secret refs (from {@link secretRefsFromInspect}); preferred over derivation. */
  secretRefs?: SecretRef[];
}

/** What one attached domain contributes to the carried spec. */
interface DomainCarry {
  /** The marker label key that says "this domain is attached". */
  marker: string;
  labels: string[];
  env: string[];
  network?: string;
  /** Secret source name + the env var holding its `/run/secrets/<target>` path. */
  secret?: { source: string; fileVar?: string };
}

const SECRETS_DIR = '/run/secrets/';

/** Vector's key-file var (mirrors `attachVectorToService`). */
function vectorKeyFileVar(envVar: string): string {
  return envVar.endsWith('_URL') ? `${envVar.slice(0, -4)}_API_KEY_FILE` : `${envVar}_API_KEY_FILE`;
}

/** Search env keys per engine, keyed by the recorded inject var (mirrors `searchAttachEnv`). */
function searchEnvKeys(injectVar: string): { env: string[]; fileVar: string } {
  if (injectVar === 'TYPESENSE_HOST') {
    return {
      env: ['TYPESENSE_HOST', 'TYPESENSE_PORT', 'TYPESENSE_PROTOCOL', 'TYPESENSE_API_KEY_FILE'],
      fileVar: 'TYPESENSE_API_KEY_FILE',
    };
  }
  return { env: ['MEILI_HOST', 'MEILI_MASTER_KEY_FILE'], fileVar: 'MEILI_MASTER_KEY_FILE' };
}

/** Every domain attached to the live service, per its marker labels. Pure. */
export function attachedDomains(source: Pick<SwarmServiceInfo, 'name' | 'labels'>): DomainCarry[] {
  const l = source.labels;
  const stack = l[STACK_LABEL];
  const out: DomainCarry[] = [];

  const db = l[DB_INJECT_LABEL];
  if (db) {
    const v = l[DB_INJECT_VAR_LABEL] || 'DATABASE_URL';
    out.push({
      marker: DB_INJECT_LABEL,
      labels: [DB_INJECT_LABEL, DB_INJECT_VAR_LABEL],
      env: [v, roVarName(v)],
      ...(stack ? { network: clusterNetworkName(stack, db) } : {}),
    });
  }

  const cache = l[CACHE_INJECT_LABEL];
  if (cache) {
    const v = l[CACHE_INJECT_VAR_LABEL] || 'REDIS_URL';
    const fileVar = cachePasswordFileVar(v);
    out.push({
      marker: CACHE_INJECT_LABEL,
      labels: [CACHE_INJECT_LABEL, CACHE_INJECT_VAR_LABEL],
      env: [v, fileVar],
      ...(stack
        ? { network: cacheNetworkName(stack, cache), secret: { source: cachePasswordSecretName(stack, cache), fileVar } }
        : {}),
    });
  }

  const search = l[SEARCH_INJECT_LABEL];
  if (search) {
    const keys = searchEnvKeys(l[SEARCH_INJECT_VAR_LABEL] || 'MEILI_HOST');
    out.push({
      marker: SEARCH_INJECT_LABEL,
      labels: [SEARCH_INJECT_LABEL, SEARCH_INJECT_VAR_LABEL],
      env: keys.env,
      ...(stack
        ? {
            network: searchNetworkName(stack, search),
            secret: { source: searchKeySecretName(stack, search), fileVar: keys.fileVar },
          }
        : {}),
    });
  }

  const vector = l[VECTOR_INJECT_LABEL];
  if (vector) {
    const v = l[VECTOR_INJECT_VAR_LABEL] || 'QDRANT_URL';
    const fileVar = vectorKeyFileVar(v);
    out.push({
      marker: VECTOR_INJECT_LABEL,
      labels: [VECTOR_INJECT_LABEL, VECTOR_INJECT_VAR_LABEL],
      env: [v, fileVar],
      ...(stack
        ? { network: vectorNetworkName(stack, vector), secret: { source: vectorKeySecretName(stack, vector), fileVar } }
        : {}),
    });
  }

  // Buckets mark with `swarmy.s3.*` (no `.inject` label); the secret NAME is
  // on its own label (rotation mints a new physical secret, same target).
  if (l[S3_BUCKET_LABEL] || l[S3_SECRET_LABEL]) {
    const secretName = l[S3_SECRET_LABEL];
    out.push({
      marker: S3_BUCKET_LABEL,
      labels: [S3_BUCKET_LABEL, S3_KEY_LABEL, S3_SECRET_LABEL],
      env: [...ATTACH_ENV_KEYS],
      network: GARAGE_NETWORK,
      ...(secretName ? { secret: { source: secretName, fileVar: 'S3_SECRET_ACCESS_KEY_FILE' } } : {}),
    });
  }

  if (l[AI_INJECT_LABEL] === 'true') {
    out.push({
      marker: AI_INJECT_LABEL,
      labels: [AI_INJECT_LABEL, AI_INJECT_KEY_LABEL],
      env: [AI_ENV_VAR, AI_KEY_FILE_VAR],
      ...(stack ? { secret: { source: aiKeySecretName(stack, source.name), fileVar: AI_KEY_FILE_VAR } } : {}),
    });
  }
  // swarmy.yaml `ai:` binding: the base URLs ride env (the key itself is a
  // secret variable, carried by `carrySecretVars`).
  if (l[AI_BIND_LABEL]) {
    out.push({ marker: AI_BIND_LABEL, labels: [AI_BIND_LABEL], env: [...AI_BIND_ENV] });
  }
  return out;
}

/** `KEY=value` strings → record (first `=` splits; later duplicates win, like Docker). */
function envRecord(env: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The exact secret refs of a raw `service.inspect` (`Spec.TaskTemplate.
 * ContainerSpec.Secrets`), in the `ServiceSpec.secrets` shape. Pure; tolerant
 * of a missing/odd payload (returns []).
 */
export function secretRefsFromInspect(inspect: unknown): SecretRef[] {
  const cs = asObj(asObj(asObj(asObj(inspect)?.Spec)?.TaskTemplate)?.ContainerSpec);
  const raw = Array.isArray(cs?.Secrets) ? cs.Secrets : [];
  const refs: SecretRef[] = [];
  for (const r of raw) {
    const ro = asObj(r);
    const source = asStr(ro?.SecretName);
    if (!ro || !source) continue;
    const file = asObj(ro.File);
    const mode = typeof file?.Mode === 'number' && Number.isFinite(file.Mode) ? file.Mode : undefined;
    refs.push({
      source,
      ...(asStr(file?.Name) ? { target: asStr(file?.Name) } : {}),
      ...(asStr(file?.UID) ? { uid: asStr(file?.UID) } : {}),
      ...(asStr(file?.GID) ? { gid: asStr(file?.GID) } : {}),
      ...(mode !== undefined ? { mode } : {}),
    });
  }
  return refs;
}

/**
 * Carry the live service's managed-data attachments onto a compose-built
 * spec. Returns `spec` itself when nothing is carried.
 */
export function carryManagedAttachments(
  spec: ServiceSpec,
  source: SwarmServiceInfo | undefined,
  extras: CarryExtras = {},
): ServiceSpec {
  if (!source) return spec;
  const domains = attachedDomains(source).filter((d) => !spec.labels?.[d.marker]);
  if (domains.length === 0) return spec;

  const liveEnv = envRecord(source.env ?? []);
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  const labels: Record<string, string> = { ...(spec.labels ?? {}) };
  const networks = [...(spec.networks ?? [])];
  const secrets: SecretRef[] = [...(spec.secrets ?? [])];
  const liveSecretNames = new Set(source.secrets ?? []);

  for (const d of domains) {
    for (const k of d.labels) {
      const v = source.labels[k];
      if (v !== undefined && labels[k] === undefined) labels[k] = v;
    }
    for (const k of d.env) {
      if (liveEnv[k] !== undefined && env[k] === undefined) env[k] = liveEnv[k];
    }
    if (d.network && !networks.includes(d.network)) networks.push(d.network);

    if (d.secret && !secrets.some((s) => s.source === d.secret!.source)) {
      // Only carry a secret the live service really mounts (an older agent
      // reports no secret names at all — then trust the convention).
      if (liveSecretNames.size > 0 && !liveSecretNames.has(d.secret.source)) continue;
      const exact = extras.secretRefs?.find((s) => s.source === d.secret!.source);
      if (exact) {
        secrets.push(exact);
      } else {
        const path = d.secret.fileVar ? env[d.secret.fileVar] ?? liveEnv[d.secret.fileVar] : undefined;
        const target = path?.startsWith(SECRETS_DIR) ? path.slice(SECRETS_DIR.length) : undefined;
        secrets.push({ source: d.secret.source, ...(target && target !== d.secret.source ? { target } : {}) });
      }
    }
  }

  return {
    ...spec,
    labels,
    ...(Object.keys(env).length ? { env } : {}),
    ...(networks.length ? { networks } : {}),
    ...(secrets.length ? { secrets } : {}),
  };
}
