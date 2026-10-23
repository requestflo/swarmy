import type { Auth } from '@swarmy/auth';
import { telemetry, type DB, type TelemetryDB } from '@swarmy/db';
import type { AgentHub } from './hub/types';

type SessionRow = Auth['$Infer']['Session']['session'];
type UserRow = Auth['$Infer']['Session']['user'];

/** Raw per-request context built in apps/api (Hono / WS upgrade). */
export interface BaseContext {
  db: DB;
  /** telemetry.db (MetricSample). Unset → the process-wide client; tests inject one. */
  telemetry?: TelemetryDB;
  hub: AgentHub;
  auth: Auth;
  session: SessionRow | null;
  user: UserRow | null;
  activeOrgId: string | null;
  reqHeaders: Headers;
  /**
   * The outgoing response's headers (tRPC fetch adapter `resHeaders`). A
   * server-side Better Auth call that re-issues session cookies (switching the
   * active org) appends its Set-Cookie here. Unset outside HTTP (WS, REST, tests).
   */
  resHeaders?: Headers;
}

/** After `protectedProcedure` — session/user are guaranteed. */
export interface AuthedContext extends BaseContext {
  session: SessionRow;
  user: UserRow;
}

/** After `orgProcedure` — active org + verified membership. */
export interface OrgContext extends AuthedContext {
  activeOrgId: string;
  membership: { role: 'owner' | 'admin' | 'member'; orgId: string };
}

export interface CreateContextOptions {
  headers: Headers;
  db: DB;
  hub: AgentHub;
  auth: Auth;
  resHeaders?: Headers;
}

export async function createContext(opts: CreateContextOptions): Promise<BaseContext> {
  const { headers, db, hub, auth, resHeaders } = opts;
  const data = await auth.api.getSession({ headers });
  const session = data?.session ?? null;
  const activeOrgId =
    (session as { activeOrganizationId?: string | null } | null)?.activeOrganizationId ?? null;
  return {
    db,
    hub,
    auth,
    session,
    user: data?.user ?? null,
    activeOrgId,
    reqHeaders: headers,
    ...(resHeaders ? { resHeaders } : {}),
  };
}

/** The telemetry.db client for a context (metric history lives in its own file). */
export function telemetryOf(ctx: { telemetry?: TelemetryDB }): TelemetryDB {
  return ctx.telemetry ?? telemetry;
}
