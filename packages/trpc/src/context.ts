import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from './hub/types';

type SessionRow = Auth['$Infer']['Session']['session'];
type UserRow = Auth['$Infer']['Session']['user'];

/** Raw per-request context built in apps/api (Hono / WS upgrade). */
export interface BaseContext {
  db: DB;
  hub: AgentHub;
  auth: Auth;
  session: SessionRow | null;
  user: UserRow | null;
  activeOrgId: string | null;
  reqHeaders: Headers;
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
}

export async function createContext(opts: CreateContextOptions): Promise<BaseContext> {
  const { headers, db, hub, auth } = opts;
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
  };
}
