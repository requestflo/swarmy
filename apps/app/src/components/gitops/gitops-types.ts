/**
 * View shapes for the Apps (GitOps) UI — mirrors of AppView / AppPlanView in
 * packages/trpc/src/services/apps.service.ts and the @swarmy/app-config Plan.
 * Only the fields the dashboard reads; kept local so the app never imports
 * server modules.
 */
export type Gate = 'auto' | 'confirm' | 'blocked';

export interface PlanActionView {
  id: string;
  kind: string;
  phase: number;
  gate: Gate;
  reason: string;
  name?: string;
  resourceType?: string;
  host?: string;
  path?: string;
  peer?: string;
}

export interface PlanView {
  stack: string;
  status: string;
  actions: PlanActionView[];
  counts: Record<Gate, number>;
}

export interface ConfigIssueView {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: (string | number)[];
  line?: number;
  col?: number;
}

export interface ActionOutcomeView {
  status: 'done' | 'held' | 'failed' | 'skipped';
  message?: string;
}

export interface AppPlan {
  id: string;
  repoId: string;
  environment: string;
  stack: string;
  sha: string;
  trigger: string;
  prNumber: number | null;
  status: string;
  plan: PlanView | null;
  issues: ConfigIssueView[];
  outcomes: Record<string, ActionOutcomeView>;
  error: string | null;
  confirmedIds: string[];
  markdown: string;
  createdAt: string;
  appliedAt: string | null;
}

export interface AppEnvironment {
  environment: string;
  branch: string;
  stack: string;
  latest: AppPlan | null;
  /** Removed Postgres clusters whose data is still on disk — the only source for "Delete data permanently". */
  keptVolumes: Array<{ resource: string; volumes: string[] }>;
}

export interface AppPreview {
  /** A branch preview's branch (absent for PR previews). */
  branch?: string;
  /** Previews with data: a copy of `from`'s latest backup, optionally scrubbed; destroyed with the preview. */
  data?: { from: string; scrub?: string };
  pr: number;
  stack: string;
  sha: string;
  status: string;
  url: string | null;
  updatedAt: string;
  planId: string;
}

export interface DriftEnv {
  environment: string;
  stack: string;
  changes: number;
}

export interface AppDrift {
  checkedAt: string;
  environments: DriftEnv[];
}

export interface GitApp {
  repoId: string;
  url: string;
  fullName: string | null;
  branch: string;
  configPath: string;
  appName: string | null;
  requireApproval: boolean;
  enforceDrift: boolean;
  environments: AppEnvironment[];
  previews: AppPreview[];
  /** Last drift check (cached by the worker); null = never checked. */
  drift: AppDrift | null;
}

/** Actions still waiting for a human on this plan. */
export function heldActions(plan: AppPlan): PlanActionView[] {
  return (plan.plan?.actions ?? []).filter(
    (a) =>
      a.gate === 'confirm' &&
      !plan.confirmedIds.includes(a.id) &&
      plan.outcomes[a.id]?.status !== 'done',
  );
}

/** The git app (and its environment or preview) that owns a stack, if any. */
export type StackAppMatch =
  | { app: GitApp; kind: 'env'; env: AppEnvironment }
  | { app: GitApp; kind: 'preview'; preview: AppPreview };

export function findStackApp(apps: GitApp[], stack: string): StackAppMatch | null {
  for (const app of apps) {
    const env = app.environments.find((e) => e.stack === stack);
    if (env) return { app, kind: 'env', env };
    const preview = app.previews.find((p) => p.stack === stack);
    if (preview) return { app, kind: 'preview', preview };
  }
  return null;
}

/** "PR #142" or "branch feature/login". */
export const previewLabel = (p: AppPreview): string =>
  p.branch ? `branch ${p.branch}` : `PR #${p.pr}`;

/** The persistent data note for a preview that carries a copy of real data. */
export function previewDataNote(p: AppPreview): string | null {
  if (!p.data) return null;
  const scrub = p.data.scrub ? `, scrubbed by ${p.data.scrub}` : '';
  return `Data: a copy of ${p.data.from}’s latest backup${scrub} — destroyed with this preview`;
}

/** A named environment (not production, not a preview) with something applied can be promoted. */
export function canPromote(env: AppEnvironment): boolean {
  return (
    env.environment !== 'production' &&
    (env.latest?.status === 'applied' || env.latest?.status === 'needs-confirmation')
  );
}
