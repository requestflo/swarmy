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
}

export interface AppPreview {
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

/** Removed Postgres resources on this plan whose volume can now be deleted for good. */
export function purgeablePostgres(plan: AppPlan): string[] {
  if (plan.prNumber) return [];
  return (plan.plan?.actions ?? [])
    .filter(
      (a) =>
        a.kind === 'resource.delete' &&
        a.resourceType === 'postgres' &&
        a.name &&
        plan.outcomes[a.id]?.status === 'done',
    )
    .map((a) => a.name as string);
}

/** The git app (and its environment or PR preview) that owns a stack, if any. */
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
