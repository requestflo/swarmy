/**
 * Rotate a managed search instance's master key (board 41), the way
 * db.rotatePassword rotates a Postgres password:
 *
 *  1. mint `<family>__v<n+1>` as a NEW Docker secret (never edit one in place);
 *  2. move the engine onto it — one redeploy, so its single copy restarts and
 *     reads the new key at boot (`searchStartCommand` cats the secret file);
 *  3. move every attached app onto it, mounted at the SAME file path
 *     (`/run/secrets/<family>`), so `MEILI_MASTER_KEY_FILE` /
 *     `TYPESENSE_API_KEY_FILE` never change — each app restarts once;
 *  4. remove the old versions once nothing mounts them (Docker refuses while
 *     in use, so a straggler keeps its version until the next rotation).
 *
 * The new key is returned ONCE and never stored controller-side. On
 * Meilisearch every API key made from the master key changes with it.
 * Router gate: `secret.delete` on the stack (as db.rotatePassword). Audited
 * `search.key.rotate` (no key in the row).
 */
import type { SearchKeyRotateResult } from '@swarmy/core';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { patchLiveService } from './service-patch';
import {
  currentKeySecret,
  generateMasterKey,
  isKeySecretOf,
  liveOrgServices,
  requireInstance,
  searchAttachEnv,
  searchBaseName,
  searchEngineOf,
  searchKeySecretName,
  SEARCH_CLUSTER_LABEL,
  SEARCH_INJECT_LABEL,
  SEARCH_KEY_SECRET_LABEL,
  SEARCH_SECRET_TARGET,
} from './search.service';

const DEPLOY_TIMEOUT_MS = 60_000;

/** PURE — the version a key secret name carries (the bare family is v1). */
export function keySecretVersion(secret: string, family: string): number {
  if (secret === family) return 1;
  const m = /__v(\d+)$/.exec(secret);
  return m ? Number(m[1]) : 1;
}

/** PURE — the names of every version below `version` (the bare family is v1). */
export function olderKeySecrets(family: string, version: number): string[] {
  const out = [family];
  for (let v = 2; v < version; v++) out.push(`${family}__v${v}`);
  return out;
}

export async function rotateSearchKey(
  ctx: OrgContext,
  input: { stack: string; name: string },
): Promise<SearchKeyRotateResult> {
  const { stack, name } = input;
  const i = requireInstance(ctx, stack, name);
  const engine = searchEngineOf(i.service.labels);
  const family = searchKeySecretName(stack, name);
  const version = keySecretVersion(currentKeySecret(i.service.labels, stack, name), family) + 1;
  const next = `${family}__v${version}`;
  const masterKey = generateMasterKey();
  const node = await resolveManagerNode(ctx);
  const ours = isKeySecretOf(stack, name);

  const create = (): Promise<unknown> =>
    ctx.hub.dispatch(node.id, 'secret.create', {
      name: next,
      dataB64: Buffer.from(masterKey, 'utf8').toString('base64'),
      labels: { 'swarmy.managed': 'true', [SEARCH_CLUSTER_LABEL]: name, 'swarmy.search.keyVersion': String(version) },
    });
  try {
    await create().catch(async (e: unknown) => {
      // Left over from a rotation that stopped before the engine moved: replace it.
      if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
      await ctx.hub.dispatch(node.id, 'secret.remove', { name: next });
      await create();
    });
  } catch (e) {
    throw mapDispatchError(e);
  }

  const redeployed: string[] = [];
  // The engine first: once it restarts, only the new key opens it.
  await patchLiveService(
    ctx,
    i.service,
    {
      removeSecrets: ours,
      addSecrets: [{ source: next, target: SEARCH_SECRET_TARGET }],
      setLabels: { [SEARCH_KEY_SECRET_LABEL]: next },
    },
    { nodeId: node.id, timeoutMs: DEPLOY_TIMEOUT_MS },
  );
  redeployed.push(i.service.name);

  // An app that fails to move must not lose the one-time key: report it, keep going.
  const failed: SearchKeyRotateResult['failed'] = [];
  const apps = liveOrgServices(ctx).filter((s) => s.stack === stack && s.labels[SEARCH_INJECT_LABEL] === name);
  for (const app of apps) {
    try {
      await patchLiveService(
        ctx,
        app,
        {
          removeSecrets: ours,
          addSecrets: [{ source: next, target: family }],
          setEnv: searchAttachEnv(engine, i.service.name, family),
        },
        { nodeId: node.id, timeoutMs: DEPLOY_TIMEOUT_MS },
      );
      redeployed.push(app.name);
    } catch (e) {
      failed.push({ service: app.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const old of olderKeySecrets(family, version)) {
    await ctx.hub.dispatch(node.id, 'secret.remove', { name: old }).catch(() => undefined);
  }
  await writeAudit(ctx, {
    action: 'search.key.rotate',
    targetType: 'searchInstance',
    targetId: searchBaseName(stack, name),
    metadata: { secret: next, version, engine, redeployed, failed: failed.map((f) => f.service) },
  });
  return { stack, name, keySecret: next, version, masterKey, redeployed, failed };
}
