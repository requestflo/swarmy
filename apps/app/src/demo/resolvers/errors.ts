import type { DemoStore, DomainResolvers } from '../types';
import { demoIssue, demoIssues, demoSetIssueStatus } from './errors-issues';

/**
 * Error-tracking demo resolvers: the stack Errors tab's setup card (opt-in
 * switch, DSN, key rotation, ingest rate limit). Issues/events fall through to
 * the fallback (empty lists). State lives in `store.extra.errors`, keyed by stack.
 */

interface ProjectView {
  stack: string;
  projectId: number;
  dsn: string;
  rateLimitPerMinute: number;
  createdAt: string;
  rotatedAt: string | null;
}

interface ErrorsState {
  enabled: Record<string, boolean>;
  projects: Record<string, ProjectView>;
}

const state = (s: DemoStore): ErrorsState => s.extra.errors as ErrorsState;
const key = (): string => Math.random().toString(16).slice(2, 18).padEnd(16, '0');

function project(st: ErrorsState, stack: string): ProjectView {
  const existing = st.projects[stack];
  if (existing) return existing;
  const projectId = Object.keys(st.projects).length + 1;
  const p: ProjectView = {
    stack,
    projectId,
    dsn: `https://${key()}@swarmy.northwind.dev/api/errors/${projectId}`,
    rateLimitPerMinute: 600,
    createdAt: new Date().toISOString(),
    rotatedAt: null,
  };
  st.projects[stack] = p;
  return p;
}

function status(st: ErrorsState, stack: string) {
  return {
    enabled: !!st.enabled[stack],
    storeEnabled: true,
    project: st.projects[stack] ?? null,
    pendingRedeploy: [] as string[],
  };
}

export const errors: DomainResolvers = {
  seed: (store) => {
    const st: ErrorsState = { enabled: { storefront: true }, projects: {} };
    project(st, 'storefront');
    store.extra.errors = st;
  },

  handlers: {
    'errors.issues': (i) => demoIssues(i as { stack: string; status?: string; query?: string }),
    'errors.issue': (i) => demoIssue(i as { stack: string; fingerprint: string }),
    'errors.setIssueStatus': (i) => demoSetIssueStatus(i as Parameters<typeof demoSetIssueStatus>[0]),
    'errors.status': (i, s) => status(state(s), (i as { stack: string }).stack),

    'errors.setEnabled': (i, s) => {
      const { stack, enabled } = i as { stack: string; enabled: boolean };
      const st = state(s);
      st.enabled[stack] = enabled;
      if (enabled) project(st, stack);
      return status(st, stack);
    },

    'errors.rotateKey': (i, s): ProjectView => {
      const p = project(state(s), (i as { stack: string }).stack);
      p.dsn = `https://${key()}@swarmy.northwind.dev/api/errors/${p.projectId}`;
      p.rotatedAt = new Date().toISOString();
      return p;
    },

    'errors.setRateLimit': (i, s): ProjectView => {
      const { stack, perMinute } = i as { stack: string; perMinute: number };
      const p = project(state(s), stack);
      p.rateLimitPerMinute = perMinute;
      return p;
    },
  },
};
