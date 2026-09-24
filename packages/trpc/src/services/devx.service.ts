/**
 * Developer-loop reads/writes the `swarmy` CLI and MCP server need that the
 * dashboard does through several calls: one service's env as a flat list
 * (plain + secret vars, masked by policy), a merge-patch of that env, and a
 * service's log lines (bounded or followed).
 *
 * Secrets stay write-only by default. A value is shown only when BOTH hold:
 * the caller explicitly asked for it (`revealSecrets`, which the REST front
 * sets only for keys carrying the `secrets.read` scope) AND ABAC permits
 * `secrets.read` on the service. Secret-VAR values (Docker secrets) are read
 * through the audited `revealSecretVar`; plain secret-looking values are
 * unmasked by the same decision `services.inspect` uses.
 */
import { looksSecret } from '@swarmy/core';
import type { EnvVar } from '@swarmy/core';
import type { LogLine } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import { resolveService } from '../abac';
import { commandRejected } from '../errors';
import { getServiceDetail, updateService } from './service.service';
import { revealSecretVar } from './app-secrets.service';
import { canReadSecrets } from './secret-redact';
import { resolveServiceLogTarget } from './live-resolve';

export interface ServiceEnvVarView {
  key: string;
  /** null = withheld (secret, not revealed). */
  value: string | null;
  /** A Docker-secret-backed var, or a plain var whose name/value looks secret. */
  secret: boolean;
  /** How a secret var reaches the process; null for plain vars. */
  delivery: 'env' | 'file' | null;
  /** The value exists but was withheld from this caller. */
  withheld: boolean;
  /** Why a requested reveal failed (e.g. no running task to read from). */
  error?: string;
}

export interface ServiceEnvView {
  serviceId: string;
  service: string;
  vars: ServiceEnvVarView[];
  /** Whether this caller may see secret values at all (ABAC `secrets.read`). */
  secretsReadable: boolean;
}

/** `<KEY>_FILE` pointers of file-delivered secret vars are plumbing, not config. */
function isFilePointer(key: string, value: string, secretKeys: Record<string, 'env' | 'file'>): boolean {
  const m = /^(.+)_FILE$/.exec(key);
  return !!m && secretKeys[m[1]!] === 'file' && value === `/run/secrets/${m[1]}`;
}

export async function readServiceEnv(
  ctx: OrgContext,
  input: { id: string; revealSecrets: boolean },
): Promise<ServiceEnvView> {
  const detail = getServiceDetail(ctx, input.id);
  const secretKeys = detail.secretKeys ?? {};
  const resource = await resolveService(ctx, { id: detail.id });
  const readable = await canReadSecrets(ctx, resource);
  const show = input.revealSecrets && readable;

  const vars: ServiceEnvVarView[] = [];
  for (const [key, value] of Object.entries(detail.env)) {
    if (secretKeys[key] || isFilePointer(key, value, secretKeys)) continue;
    const secret = looksSecret(key, value);
    const withheld = secret && !show;
    vars.push({ key, value: withheld ? null : value, secret, delivery: null, withheld });
  }
  for (const [key, delivery] of Object.entries(secretKeys)) {
    if (!show) {
      vars.push({ key, value: null, secret: true, delivery, withheld: true });
      continue;
    }
    try {
      const r = await revealSecretVar(ctx, { id: detail.id, key });
      vars.push({ key, value: r.value, secret: true, delivery, withheld: false });
    } catch (e) {
      vars.push({
        key,
        value: null,
        secret: true,
        delivery,
        withheld: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  vars.sort((a, b) => a.key.localeCompare(b.key));
  return { serviceId: detail.id, service: detail.name, vars, secretsReadable: readable };
}

export interface PatchServiceEnvInput {
  id: string;
  /** Plain vars to add or change. */
  set?: Record<string, string>;
  /** Secret vars to create or rotate (become Docker secrets; never readable back). */
  secrets?: Record<string, string>;
  /** Keys to remove (plain or secret). */
  unset?: string[];
}

/**
 * Merge-patch one service's env and roll it out. Keys not named are kept
 * exactly — secret vars included (sent as "keep", never re-read). A key moved
 * from `secrets` to `set` becomes plain (the service demotes it).
 */
export async function patchServiceEnv(
  ctx: OrgContext,
  input: PatchServiceEnvInput,
): Promise<{ id: string; deploymentId: string; changed: string[] }> {
  const set = input.set ?? {};
  const secrets = input.secrets ?? {};
  const unset = new Set(input.unset ?? []);
  for (const k of Object.keys(set)) {
    if (k in secrets) throw commandRejected(`${k} is in both set and secrets — pick one`);
  }
  const detail = getServiceDetail(ctx, input.id);
  const secretKeys = detail.secretKeys ?? {};

  const env: EnvVar[] = [];
  const plain = new Map<string, string>();
  for (const [key, value] of Object.entries(detail.env)) {
    if (secretKeys[key] || isFilePointer(key, value, secretKeys)) continue;
    plain.set(key, value);
  }
  for (const [k, v] of Object.entries(set)) plain.set(k, v);
  for (const k of unset) plain.delete(k);
  for (const k of Object.keys(secrets)) plain.delete(k);
  for (const [key, value] of plain) env.push({ key, value });

  for (const [key, delivery] of Object.entries(secretKeys)) {
    if (unset.has(key) || key in set || key in secrets) continue;
    env.push({ key, value: '', secret: true, delivery }); // keep as-is
  }
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) throw commandRejected(`secret ${key} needs a value`);
    env.push({ key, value, secret: true, delivery: secretKeys[key] ?? 'env' });
  }

  const removeSecretKeys = [...unset].filter((k) => secretKeys[k]);
  const r = await updateService(ctx, {
    id: detail.id,
    env,
    ...(removeSecretKeys.length ? { removeSecretKeys } : {}),
  } as Parameters<typeof updateService>[1]);
  const changed = [...new Set([...Object.keys(set), ...Object.keys(secrets), ...unset])].sort();
  return { id: r.id, deploymentId: r.deploymentId, changed };
}

/**
 * Stream (or tail) a service's log lines — the same agent path `services.logs`
 * uses. Resolves the service FIRST (so an unknown id throws before a stream
 * starts), then returns the line iterator.
 */
export async function serviceLogLines(
  ctx: OrgContext,
  input: { id: string; tail: number; follow: boolean; since?: number },
  signal: AbortSignal,
): Promise<AsyncIterable<LogLine>> {
  const { serviceName, nodeId } = await resolveServiceLogTarget(ctx, input.id);
  return ctx.hub.subscribeLogLines(
    nodeId,
    {
      action: 'start',
      target: { kind: 'service', service: serviceName },
      tail: input.tail,
      follow: input.follow,
      ...(input.since !== undefined ? { since: input.since } : {}),
    },
    signal,
  );
}

/** The last `tail` lines, returned once the stream ends (or `timeoutMs` passes). */
export async function collectServiceLogs(
  ctx: OrgContext,
  input: { id: string; tail: number; since?: number },
  timeoutMs = 8_000,
): Promise<LogLine[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const lines: LogLine[] = [];
  try {
    const stream = await serviceLogLines(ctx, { ...input, follow: false }, ac.signal);
    for await (const l of stream) {
      lines.push(l);
      if (lines.length > input.tail) lines.shift();
    }
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return lines;
}
