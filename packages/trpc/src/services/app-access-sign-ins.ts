/**
 * Recent sign-ins to a login-protected app (the Access tab, board 65): who
 * signed in, when and how, and who was refused. A query over the audit log,
 * no table of its own:
 *
 *   - `app.access.login`       one row per completed sign-in (completeAppLogin),
 *                              never per request; carries the swarmy sign-in method;
 *   - `authz.deny:app.access`  a signed-in person refused, throttled to one row
 *                              a minute per person and host (app-access-decide.ts).
 *
 * Both are filed under the app (its stack, or the lone service), so the read
 * is one org-scoped, indexed query; the org's audit retention prunes them.
 */
import { displayEmail, parseSignInMethod } from '@swarmy/auth';
import type { OrgContext } from '../context';
import { listRoutesForOrg } from './ingress-routes';

export const APP_LOGIN_ACTION = 'app.access.login';
export const APP_DENY_ACTION = 'authz.deny:app.access';
export const SIGN_INS_MAX = 50;

export interface AppSignIn {
  id: string;
  at: string;
  outcome: 'allowed' | 'denied';
  userId: string | null;
  name: string | null;
  email: string | null;
  host: string | null;
  path: string | null;
  /** How they signed in to swarmy (sign-ins only): "Okta (SSO)", "GitHub", "Password + 2FA". */
  via: string | null;
  /** Why a refusal happened, in words (refusals only). */
  reason: string | null;
}

const SOCIAL: Record<string, string> = { github: 'GitHub', google: 'Google', microsoft: 'Microsoft', gitlab: 'GitLab' };

/** `Session.signInMethod` in words, naming the org's own SSO providers. */
export function signInMethodLabel(method: string | null | undefined, ssoNames: ReadonlyMap<string, string>): string | null {
  const s = parseSignInMethod(method);
  if (!s) return method ? 'swarmy sign-in' : null;
  const id = s.providerId ?? '';
  switch (s.kind) {
    case 'sso':
      return `${ssoNames.get(id) ?? (id || 'single sign-on')} (SSO)`;
    case 'social':
      return SOCIAL[id] ?? (id || 'Social sign-in');
    case 'password':
      return 'Password';
    case 'password_2fa':
      return 'Password + 2FA';
    case 'email_link':
      return 'Email link';
    case 'passkey':
      return 'Passkey';
  }
}

/** A refusal's audited reason in words. */
export function denyReasonWords(reason: unknown, path: unknown): string {
  const under = typeof path === 'string' && path ? ` under ${path}` : '';
  switch (reason) {
    case 'not-member':
      return 'Not in this organisation';
    case 'wall':
      return 'Has to finish signing in to swarmy (2FA or SSO)';
    case 'path':
      return `Not allowed${under}`;
    case 'rules':
      return "The app's path rules couldn't be read";
    case 'sso':
      return 'Signed in without the organisation’s SSO';
    default:
      return 'Not on the list of who can enter';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The last `limit` sign-ins and refusals for one app, newest first. */
export async function recentAppSignIns(ctx: OrgContext, input: { stack: string; limit?: number }): Promise<AppSignIn[]> {
  const take = Math.min(Math.max(1, input.limit ?? 20), SIGN_INS_MAX);
  const routes = listRoutesForOrg(ctx).filter((r) => r.stack === input.stack);
  const services = [...new Set(routes.map((r) => r.serviceName))];
  const hosts = [...new Set(routes.map((r) => r.route.host.toLowerCase()))];
  const [rows, sso] = await Promise.all([
    ctx.db.auditLog.findMany({
      where: {
        orgId: ctx.activeOrgId,
        action: { in: [APP_LOGIN_ACTION, APP_DENY_ACTION] },
        OR: [
          { targetType: 'stack', targetId: input.stack },
          ...(services.length ? [{ targetType: 'service', targetId: { in: services } }] : []),
          // Sign-ins recorded before rows were filed under the app named the host.
          ...(hosts.length ? [{ targetType: 'app', targetId: { in: hosts } }] : []),
        ],
      },
      orderBy: { ts: 'desc' },
      take,
      include: { actor: { select: { name: true, email: true } } },
    }),
    ctx.db.ssoProvider.findMany({ where: { orgId: ctx.activeOrgId }, select: { providerId: true, metadata: true } }),
  ]);
  const ssoNames = new Map(
    sso.map((p) => [p.providerId, str((p.metadata as Record<string, unknown> | null)?.displayName)?.trim() || p.providerId]),
  );
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const allowed = r.action === APP_LOGIN_ACTION;
    return {
      id: String(r.id),
      at: r.ts.toISOString(),
      outcome: allowed ? 'allowed' : 'denied',
      userId: r.actorId,
      name: r.actor?.name || null,
      email: displayEmail(r.actor?.email ?? null),
      host: str(m.host),
      path: str(m.path),
      via: allowed ? signInMethodLabel(str(m.method), ssoNames) : null,
      reason: allowed ? null : denyReasonWords(m.reason, m.path),
    };
  });
}
