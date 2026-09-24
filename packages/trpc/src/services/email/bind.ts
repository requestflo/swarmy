/**
 * Bind an app service to the email service — swarmy.yaml `email:` and
 * `${{ email.* }}`, applied on deploy (git apps' `email` attachment, the
 * templates' `email` wire).
 *
 * One credential per app (minted on first bind; derived SMTP password + API
 * key, so re-binding never rotates). Addressing fields ride env (and are
 * carried across later compose deploys by the `swarmy.email.bind` marker,
 * attachment-carry.ts); the password and API key are secret variables —
 * Docker secrets exported by the env shim, never in the spec.
 */
import { buildInventory, STACK_LABEL, type InvService } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { mapDispatchError, notFound } from '../../errors';
import { writeAudit } from '../audit.service';
import { listAppSecretVersions, materializeSecretVars, mountedVersions, planSecretSpec, versionsOf } from '../app-secrets.service';
import { resolveManagerNode } from '../dispatch.service';
import { ensureAppEmailCredential } from '../email.service';
import { patchLiveService } from '../service-patch';
import { EMAIL_BIND_LABEL, MAIL_HOST, SUBMISSION_PORT } from './maddy';
import { emailApiUrl } from './runtime';

export { EMAIL_BIND_LABEL };

export type EmailField = 'host' | 'port' | 'user' | 'password' | 'from' | 'api_url' | 'api_key';
const CREDENTIAL: ReadonlySet<EmailField> = new Set(['password', 'api_key']);

export interface EmailBindInput {
  stack: string;
  appService: string;
  /** Sender address; null = noreply@<org sending domain>. */
  from: string | null;
  /** env name → field. */
  env: Record<string, EmailField>;
}

/** Split a binding into plain env values and secret-variable keys. Pure. */
export function emailBindingValues(
  env: Record<string, EmailField>,
  v: { user: string; password: string; apiKey: string; from: string; apiUrl: string },
): { plain: Record<string, string>; secret: Array<{ key: string; value: string }> } {
  const value: Record<EmailField, string> = {
    host: MAIL_HOST,
    port: String(SUBMISSION_PORT),
    user: v.user,
    password: v.password,
    from: v.from,
    api_url: v.apiUrl,
    api_key: v.apiKey,
  };
  const plain: Record<string, string> = {};
  const secret: Array<{ key: string; value: string }> = [];
  for (const [k, f] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (CREDENTIAL.has(f)) secret.push({ key: k, value: value[f] });
    else plain[k] = value[f];
  }
  return { plain, secret };
}

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

export async function bindEmailToService(ctx: OrgContext, input: EmailBindInput): Promise<{ appService: string; env: string[]; secretVars: string[] }> {
  const app = liveOrgServices(ctx).find((s) => s.stack === input.stack && (s.id === input.appService || s.name === input.appService));
  if (!app) throw notFound('service', input.appService);
  const cred = await ensureAppEmailCredential(ctx, input.stack, input.from);
  const { plain, secret } = emailBindingValues(input.env, {
    user: cred.username,
    password: cred.password,
    apiKey: cred.apiKey,
    from: cred.from,
    apiUrl: emailApiUrl(),
  });
  const node = await resolveManagerNode(ctx);
  const owned = versionsOf(await listAppSecretVersions(ctx, node.id), app.name);
  const mounted = mountedVersions(owned, app.secrets ?? []);
  try {
    const { desired } = await materializeSecretVars(
      ctx,
      node.id,
      app.name,
      secret.map((s) => ({ key: s.key, value: mounted.has(s.key) ? undefined : s.value, delivery: 'env' as const })),
      owned,
      mounted,
    );
    await patchLiveService(
      ctx,
      app,
      {
        setEnv: plain,
        setLabels: { [STACK_LABEL]: input.stack, [EMAIL_BIND_LABEL]: JSON.stringify(Object.keys(plain)) },
        transform: (spec) => planSecretSpec(spec, owned, { upserts: desired }),
      },
      { nodeId: node.id },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'email.bind',
    targetType: 'service',
    targetId: app.name,
    actorType: ctx.user ? 'user' : 'system',
    metadata: { stack: input.stack, from: cred.from, env: Object.keys(plain), secretVars: secret.map((s) => s.key) },
  });
  return { appService: app.name, env: Object.keys(plain), secretVars: secret.map((s) => s.key) };
}
