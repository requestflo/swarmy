import type {
  WorkflowDefVersionView,
  WorkflowDefView,
  WorkflowRunDetailView,
  WorkflowRunStatusView,
  WorkflowRunView,
  WorkflowRunsPage,
  WorkflowStepInput,
  WorkflowStepRunView,
  WorkflowStepView,
  WorkflowsOverview,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Workflow-engine demo resolvers — the Workflows surface (`/workflows`) and the
 * run detail (`/workflows/$runId`). Return shapes mirror the tRPC views in
 * `@swarmy/core` exactly. Seeded with the `document-pipeline` definition and
 * runs in every state (incl. one waiting for approval, so the decision UI is
 * exercisable: approve resumes it, reject fails it).
 */

// ── demo world ────────────────────────────────────────────────────────────────

interface DemoRun {
  id: string;
  defId: string;
  defName: string;
  defVersion: number;
  status: WorkflowRunStatusView;
  cursor: number;
  startedAt: string;
  finishedAt: string | null;
  input: string | null;
  steps: WorkflowStepRunView[];
  approvalPrompt: string | null;
}

/** `WorkflowDefView` + the stack-scoped IA field (mirrors workflows.service.ts). */
type WfDefSeed = WorkflowDefView & { stackName: string | null };

interface WfState {
  defs: WfDefSeed[];
  runs: DemoRun[];
}

const getState = (s: DemoStore): WfState => s.extra.workflows as WfState;
const nowIso = (): string => new Date().toISOString();
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const rid = (): string => `wfr-${Math.random().toString(36).slice(2, 10)}`;

function toRunView(r: DemoRun): WorkflowRunView {
  const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
  const cursor = Math.min(r.cursor, Math.max(0, r.steps.length - 1));
  return {
    id: r.id,
    defId: r.defId,
    defName: r.defName,
    defVersion: r.defVersion,
    status: r.status,
    cursor: r.cursor,
    totalSteps: r.steps.length,
    currentStep: r.steps[cursor]?.name ?? null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: Math.max(0, end - new Date(r.startedAt).getTime()),
  };
}

function toRunDetail(r: DemoRun): WorkflowRunDetailView {
  return { ...toRunView(r), input: r.input, steps: r.steps, approvalPrompt: r.approvalPrompt };
}

function refreshLastRun(st: WfState): void {
  for (const def of st.defs) {
    const runs = st.runs
      .filter((r) => r.defName === def.name)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    def.lastRunAt = runs[0]?.startedAt ?? null;
    def.lastRunStatus = runs[0]?.status ?? null;
  }
}

/** Submitted builder steps → step views (mirror of the service's mapping). */
function inputToView(steps: WorkflowStepInput[]): WorkflowStepView[] {
  return steps.map((s) => {
    const { secret, ...rest } = s.config ?? {};
    return {
      name: s.name,
      kind: s.kind,
      config: { ...rest, ...(secret ? { hasSecret: true } : {}) },
      timeoutMs: s.timeoutMs ?? null,
      retries: s.retries ?? null,
    };
  });
}

// ── resolvers ─────────────────────────────────────────────────────────────────

export const workflows: DomainResolvers = {
  handlers: {
    'workflows.overview': (i, s): WorkflowsOverview => {
      const { stack } = (i ?? {}) as { stack?: string };
      const st = getState(s);
      const defs = st.defs.filter((d) => (stack ? d.stackName === stack : true));
      const defNames = new Set(defs.map((d) => d.name));
      const runs = st.runs.filter((r) => defNames.has(r.defName));
      const since = Date.now() - 24 * 3_600_000;
      const finished = runs.filter((r) => r.finishedAt && new Date(r.finishedAt).getTime() >= since);
      return {
        defs: defs.length,
        enabled: defs.filter((d) => d.enabled).length,
        running: runs.filter((r) => r.status === 'running').length,
        waitingApproval: runs.filter((r) => r.status === 'waiting-approval').length,
        succeeded24h: finished.filter((r) => r.status === 'succeeded').length,
        failed24h: finished.filter((r) => r.status === 'failed').length,
      };
    },

    'workflows.defs': (i, s): WorkflowDefView[] => {
      const { stack } = (i ?? {}) as { stack?: string };
      const st = getState(s);
      refreshLastRun(st);
      return [...st.defs]
        .filter((d) => (stack ? d.stackName === stack : true))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },

    'workflows.versions': (i, s): WorkflowDefVersionView[] => {
      const { name } = i as { name: string };
      const def = getState(s).defs.find((d) => d.name === name);
      if (!def) throw new Error(`workflow "${name}" not found`);
      return Array.from({ length: def.versions }, (_, k) => {
        const version = def.version - k;
        return {
          id: version === def.version ? def.id : `${def.id}-v${version}`,
          version,
          stepCount: def.steps.length,
          stepNames: def.steps.map((st2) => st2.name),
          enabled: def.enabled,
          createdAt: ago((k + 1) * 86_400_000),
        };
      });
    },

    'workflows.runs': (i, s): WorkflowRunsPage => {
      const { defName, stack, limit = 25 } =
        (i as { defName?: string; stack?: string; limit?: number } | undefined) ?? {};
      const st = getState(s);
      const stackDefNames = stack
        ? new Set(st.defs.filter((d) => d.stackName === stack).map((d) => d.name))
        : null;
      const rows = st.runs
        .filter((r) => (stackDefNames ? stackDefNames.has(r.defName) : true))
        .filter((r) => !defName || r.defName === defName)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, limit);
      return { runs: rows.map(toRunView), nextCursor: null };
    },

    'workflows.run': (i, s): WorkflowRunDetailView => {
      const { runId } = i as { runId: string };
      const run = getState(s).runs.find((r) => r.id === runId);
      if (!run) throw new Error(`workflow run "${runId}" not found`);
      return toRunDetail(run);
    },

    'workflows.create': (i, s): WorkflowDefView => {
      const b = i as { name: string; steps: WorkflowStepInput[]; enabled?: boolean; stackName?: string };
      const st = getState(s);
      if (st.defs.some((d) => d.name === b.name)) throw new Error(`a workflow named "${b.name}" already exists`);
      const def: WfDefSeed = {
        id: `wfd-${b.name}`,
        name: b.name,
        stackName: b.stackName ?? null,
        version: 1,
        versions: 1,
        enabled: b.enabled ?? true,
        steps: inputToView(b.steps),
        lastRunAt: null,
        lastRunStatus: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      st.defs = [...st.defs, def];
      return def;
    },

    'workflows.update': (i, s): WorkflowDefView => {
      const b = i as { name: string; steps: WorkflowStepInput[]; enabled?: boolean; stackName?: string };
      const def = getState(s).defs.find((d) => d.name === b.name);
      if (!def) throw new Error(`workflow "${b.name}" not found`);
      def.version += 1;
      def.versions += 1;
      def.steps = inputToView(b.steps);
      if (b.enabled !== undefined) def.enabled = b.enabled;
      if (b.stackName !== undefined) def.stackName = b.stackName;
      def.updatedAt = nowIso();
      return def;
    },

    'workflows.setEnabled': (i, s): { name: string; enabled: boolean } => {
      const { name, enabled } = i as { name: string; enabled: boolean };
      const def = getState(s).defs.find((d) => d.name === name);
      if (def) def.enabled = enabled;
      return { name, enabled };
    },

    'workflows.remove': (i, s): { name: string } => {
      const { name } = i as { name: string };
      const st = getState(s);
      st.defs = st.defs.filter((d) => d.name !== name);
      st.runs = st.runs.filter((r) => r.defName !== name);
      return { name };
    },

    'workflows.trigger': (i, s): { runId: string; defId: string } => {
      const b = i as { defId?: string; name?: string; inputJson?: string };
      const st = getState(s);
      const def = st.defs.find((d) => d.id === b.defId || d.name === b.name);
      if (!def) throw new Error('workflow not found');
      if (!def.enabled) throw new Error(`workflow "${def.name}" is disabled`);
      const run: DemoRun = {
        id: rid(),
        defId: def.id,
        defName: def.name,
        defVersion: def.version,
        status: 'running',
        cursor: 0,
        startedAt: nowIso(),
        finishedAt: null,
        input: b.inputJson?.trim() ? b.inputJson : null,
        steps: def.steps.map((step, index) => ({
          index,
          name: step.name,
          kind: step.kind,
          status: index === 0 ? 'running' : 'pending',
          startedAt: index === 0 ? nowIso() : null,
          finishedAt: null,
          output: null,
          error: null,
        })),
        approvalPrompt: null,
      };
      st.runs = [run, ...st.runs];
      return { runId: run.id, defId: def.id };
    },

    'workflows.cancel': (i, s): { runId: string } => {
      const { runId } = i as { runId: string };
      const run = getState(s).runs.find((r) => r.id === runId);
      if (!run) throw new Error('run not found');
      if (run.status !== 'running' && run.status !== 'waiting-approval') {
        throw new Error('run is already finished');
      }
      run.status = 'cancelled';
      run.finishedAt = nowIso();
      run.approvalPrompt = null;
      for (const step of run.steps) {
        if (step.status === 'running' || step.status === 'waiting') {
          step.status = 'cancelled';
          step.finishedAt = nowIso();
          step.error = 'cancelled by user';
        }
      }
      return { runId };
    },

    'workflows.approve': (i, s): { runId: string } => {
      const { runId, note } = i as { runId: string; note?: string };
      const run = getState(s).runs.find((r) => r.id === runId);
      if (!run || run.status !== 'waiting-approval') throw new Error('run is not waiting for approval');
      const step = run.steps[run.cursor]!;
      step.status = 'succeeded';
      step.finishedAt = nowIso();
      step.output = JSON.stringify({ approved: true, by: s.user.email, ...(note ? { note } : {}) }, null, 2);
      run.cursor += 1;
      run.approvalPrompt = null;
      if (run.cursor >= run.steps.length) {
        run.status = 'succeeded';
        run.finishedAt = nowIso();
      } else {
        run.status = 'running';
        const next = run.steps[run.cursor]!;
        next.status = 'running';
        next.startedAt = nowIso();
      }
      return { runId };
    },

    'workflows.reject': (i, s): { runId: string } => {
      const { runId, note } = i as { runId: string; note?: string };
      const run = getState(s).runs.find((r) => r.id === runId);
      if (!run || run.status !== 'waiting-approval') throw new Error('run is not waiting for approval');
      const step = run.steps[run.cursor]!;
      step.status = 'failed';
      step.finishedAt = nowIso();
      step.error = `rejected by ${s.user.email}${note ? `: ${note}` : ''}`;
      run.status = 'failed';
      run.finishedAt = nowIso();
      run.approvalPrompt = null;
      return { runId };
    },
  },

  seed: (store) => {
    // The flagship def: extract → index → notify CRM → human sign-off → cool-down.
    const pipelineSteps: WorkflowStepView[] = [
      {
        name: 'extract-text',
        kind: 'container',
        config: {
          image: 'ghcr.io/northwind/doc-extract:1.4',
          command: ['node', 'extract.js', '--batch'],
          env: { MODE: 'incremental' },
        },
        timeoutMs: 600_000,
        retries: 1,
      },
      {
        name: 'index-docs',
        kind: 'service-exec',
        config: { serviceRef: 'search-indexer', command: ['./bin/index-all', '--since=1d'] },
        timeoutMs: 300_000,
        retries: 0,
      },
      {
        name: 'notify-crm',
        kind: 'webhook',
        config: { url: 'https://crm.northwind.dev/hooks/docs', hasSecret: true },
        timeoutMs: 30_000,
        retries: 2,
      },
      {
        name: 'publish-approval',
        kind: 'approval',
        config: { prompt: 'Publish the re-indexed documents to production search?' },
        timeoutMs: null,
        retries: null,
      },
      { name: 'cool-down', kind: 'delay', config: { seconds: 300 }, timeoutMs: null, retries: null },
    ];

    const defs: WfDefSeed[] = [
      {
        id: 'wfd-document-pipeline',
        name: 'document-pipeline',
        stackName: 'platform',
        version: 3,
        versions: 3,
        enabled: true,
        steps: pipelineSteps,
        lastRunAt: null,
        lastRunStatus: null,
        createdAt: ago(21 * 86_400_000),
        updatedAt: ago(2 * 86_400_000),
      },
      {
        id: 'wfd-nightly-cleanup',
        name: 'nightly-cleanup',
        stackName: 'storefront',
        version: 1,
        versions: 1,
        enabled: true,
        steps: [
          {
            name: 'prune-uploads',
            kind: 'container',
            config: { image: 'alpine:3.20', command: ['sh', '-c', 'find /data -mtime +30 -delete'] },
            timeoutMs: 300_000,
            retries: 0,
          },
          {
            name: 'report',
            kind: 'webhook',
            config: { url: 'https://ops.northwind.dev/hooks/cleanup' },
            timeoutMs: 30_000,
            retries: 2,
          },
        ],
        lastRunAt: null,
        lastRunStatus: null,
        createdAt: ago(9 * 86_400_000),
        updatedAt: ago(9 * 86_400_000),
      },
    ];

    const stepRun = (
      index: number,
      status: WorkflowStepRunView['status'],
      startOffsetMs: number | null,
      durMs: number | null,
      output?: string,
      error?: string,
    ): WorkflowStepRunView => ({
      index,
      name: pipelineSteps[index]!.name,
      kind: pipelineSteps[index]!.kind,
      status,
      startedAt: startOffsetMs != null ? ago(startOffsetMs) : null,
      finishedAt: startOffsetMs != null && durMs != null ? ago(startOffsetMs - durMs) : null,
      output: output ?? null,
      error: error ?? null,
    });

    const extractOut = JSON.stringify({ exitCode: 0, output: 'extracted 214 documents (12.4 MB)' }, null, 2);
    const indexOut = JSON.stringify({ exitCode: 0, output: 'indexed 214/214 docs in 41s' }, null, 2);
    const crmOut = JSON.stringify({ status: 200, body: '{"ok":true,"queued":214}' }, null, 2);

    const runs: DemoRun[] = [
      // Waiting for a human — the approval card is live on this one.
      {
        id: 'wfr-approval-demo',
        defId: 'wfd-document-pipeline',
        defName: 'document-pipeline',
        defVersion: 3,
        status: 'waiting-approval',
        cursor: 3,
        startedAt: ago(25 * 60_000),
        finishedAt: null,
        input: JSON.stringify({ source: 's3://northwind-docs/incoming', batch: '2026-07-02' }, null, 2),
        steps: [
          stepRun(0, 'succeeded', 25 * 60_000, 84_000, extractOut),
          stepRun(1, 'succeeded', 23 * 60_000, 41_000, indexOut),
          stepRun(2, 'succeeded', 22 * 60_000, 900, crmOut),
          stepRun(3, 'waiting', 21 * 60_000, null),
          stepRun(4, 'pending', null, null),
        ],
        approvalPrompt: 'Publish the re-indexed documents to production search?',
      },
      // In flight right now.
      {
        id: 'wfr-running-demo',
        defId: 'wfd-document-pipeline',
        defName: 'document-pipeline',
        defVersion: 3,
        status: 'running',
        cursor: 1,
        startedAt: ago(95_000),
        finishedAt: null,
        input: null,
        steps: [
          stepRun(0, 'succeeded', 95_000, 78_000, extractOut),
          stepRun(1, 'running', 15_000, null),
          stepRun(2, 'pending', null, null),
          stepRun(3, 'pending', null, null),
          stepRun(4, 'pending', null, null),
        ],
        approvalPrompt: null,
      },
      // A clean pass this morning.
      {
        id: 'wfr-succeeded-demo',
        defId: 'wfd-document-pipeline',
        defName: 'document-pipeline',
        defVersion: 3,
        status: 'succeeded',
        cursor: 5,
        startedAt: ago(2 * 3_600_000),
        finishedAt: ago(2 * 3_600_000 - 9 * 60_000),
        input: JSON.stringify({ source: 's3://northwind-docs/incoming', batch: '2026-07-01' }, null, 2),
        steps: [
          stepRun(0, 'succeeded', 2 * 3_600_000, 80_000, extractOut),
          stepRun(1, 'succeeded', 2 * 3_600_000 - 90_000, 44_000, indexOut),
          stepRun(2, 'succeeded', 2 * 3_600_000 - 140_000, 700, crmOut),
          stepRun(
            3,
            'succeeded',
            2 * 3_600_000 - 150_000,
            180_000,
            JSON.stringify({ approved: true, by: store.user.email, note: 'looks good' }, null, 2),
          ),
          stepRun(4, 'succeeded', 2 * 3_600_000 - 335_000, 300_000, JSON.stringify({ delayedSeconds: 300 }, null, 2)),
        ],
        approvalPrompt: null,
      },
      // The CRM hook flaked yesterday: retried, then failed the run.
      {
        id: 'wfr-failed-demo',
        defId: 'wfd-document-pipeline',
        defName: 'document-pipeline',
        defVersion: 2,
        status: 'failed',
        cursor: 2,
        startedAt: ago(26 * 3_600_000),
        finishedAt: ago(26 * 3_600_000 - 4 * 60_000),
        input: null,
        steps: [
          stepRun(0, 'succeeded', 26 * 3_600_000, 91_000, extractOut),
          stepRun(1, 'succeeded', 26 * 3_600_000 - 100_000, 39_000, indexOut),
          stepRun(2, 'failed', 26 * 3_600_000 - 145_000, 95_000, undefined, 'HTTP 503: upstream unavailable (3 attempts)'),
          stepRun(3, 'pending', null, null),
          stepRun(4, 'pending', null, null),
        ],
        approvalPrompt: null,
      },
      // Cancelled mid-extract a few days back.
      {
        id: 'wfr-cancelled-demo',
        defId: 'wfd-document-pipeline',
        defName: 'document-pipeline',
        defVersion: 2,
        status: 'cancelled',
        cursor: 0,
        startedAt: ago(3 * 86_400_000),
        finishedAt: ago(3 * 86_400_000 - 42_000),
        input: null,
        steps: [
          stepRun(0, 'cancelled', 3 * 86_400_000, 42_000, undefined, 'cancelled by user'),
          stepRun(1, 'pending', null, null),
          stepRun(2, 'pending', null, null),
          stepRun(3, 'pending', null, null),
          stepRun(4, 'pending', null, null),
        ],
        approvalPrompt: null,
      },
      // Last night's cleanup, quick and green.
      {
        id: 'wfr-cleanup-demo',
        defId: 'wfd-nightly-cleanup',
        defName: 'nightly-cleanup',
        defVersion: 1,
        status: 'succeeded',
        cursor: 2,
        startedAt: ago(9 * 3_600_000),
        finishedAt: ago(9 * 3_600_000 - 23_000),
        input: null,
        steps: [
          {
            index: 0,
            name: 'prune-uploads',
            kind: 'container',
            status: 'succeeded',
            startedAt: ago(9 * 3_600_000),
            finishedAt: ago(9 * 3_600_000 - 21_000),
            output: JSON.stringify({ exitCode: 0, output: 'removed 1,204 stale files' }, null, 2),
            error: null,
          },
          {
            index: 1,
            name: 'report',
            kind: 'webhook',
            status: 'succeeded',
            startedAt: ago(9 * 3_600_000 - 21_000),
            finishedAt: ago(9 * 3_600_000 - 23_000),
            output: JSON.stringify({ status: 200, body: '{"ok":true}' }, null, 2),
            error: null,
          },
        ],
        approvalPrompt: null,
      },
    ];

    store.extra.workflows = { defs, runs } satisfies WfState;
  },
};
