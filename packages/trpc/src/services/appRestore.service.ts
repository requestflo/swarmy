/**
 * Whole-app restore (`backups.restoreApp`, board 10): every saved volume and
 * managed database of one app back to one moment, as one operation.
 *
 * Before anything is touched: the app's name typed back, one restore per app
 * at a time, a fresh plan from the controller's own reads (a part that can't
 * reach the moment refuses the whole restore), the server that holds each
 * volume, and each database's engine and recoverable window. Then the run
 * (appRestore.run): stop once, part by part with a safety copy each, put the
 * done parts back if one fails, start again. One `app.restore` audit row
 * lists every part; each part's own path writes its usual rows too.
 */
import { planAppRestore, type AppRestorePlan, type AppRestoreResultView, type AppRestoreScopeView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { badRequest, commandRejected } from '../errors';
import { writeAudit } from './audit.service';
import { appRestoreScope, scopeServices } from './appRestore.scope';
import { gatherPlanInputs, type VolumeFacts } from './appRestore.inputs';
import { runAppRestore, type AppRestoreRun } from './appRestore.run';
import { bindSteps, type StepTiming } from './appRestore.steps';
import { failureWords, refusalWords } from './appRestore.words';
import { preflightPitrFromSource } from './dbBackup.service';
import { assertEngineOffered } from './dbBackupEngines';
import { nodesRunning } from './volumeMove.service';

export const APP_RESTORE_AUDIT_ACTION = 'app.restore';

const running = new Set<string>();

/** The server each volume is on: where a service that mounts it runs, else where its newest save ran. */
function volumeNodes(ctx: OrgContext, plan: AppRestorePlan, facts: Map<string, VolumeFacts>): Map<string, string> {
  const services = scopeServices(ctx);
  const out = new Map<string, string>();
  const lost: string[] = [];
  for (const p of plan.parts.filter((x) => x.kind === 'volume')) {
    const live = services.filter((s) => s.volumes.includes(p.name)).flatMap((s) => nodesRunning(ctx, s.name))[0];
    const saved = facts.get(p.name)?.newestHost;
    const node = live ?? (saved && ctx.hub.isOnline(saved) ? saved : undefined);
    if (node) out.set(p.name, node);
    else lost.push(p.name);
  }
  if (lost.length) throw commandRejected(`swarmy can't reach the server that holds ${lost.join(', ')}, so nothing was restored.`);
  return out;
}

async function preflightDatabases(ctx: OrgContext, stack: string, plan: AppRestorePlan): Promise<void> {
  for (const p of plan.parts.filter((x) => x.kind === 'database')) {
    assertEngineOffered(p.engine!);
    if (p.method === 'pitr') {
      await preflightPitrFromSource(ctx, { stack, cluster: p.name, engine: p.engine!, targetTime: new Date(p.at).toISOString() });
    }
  }
}

function view(stack: string, plan: AppRestorePlan, scope: AppRestoreScopeView, run: AppRestoreRun): AppRestoreResultView {
  return {
    stack,
    at: new Date(plan.at).toISOString(),
    skewMs: plan.skewMs,
    stopped: scope.stops.map((s) => s.service),
    parts: run.parts,
    ...(run.startError ? { startError: run.startError } : {}),
  };
}

export async function restoreApp(
  ctx: OrgContext,
  input: { stack: string; at: string; confirm: string },
  timing?: StepTiming,
): Promise<AppRestoreResultView> {
  const { stack } = input;
  if (input.confirm.trim() !== stack) throw badRequest(`type ${stack} to restore the whole app`);
  const at = Date.parse(input.at);
  if (!Number.isFinite(at) || at > Date.now()) throw badRequest('pick a moment in the past to restore to');
  const key = `${ctx.activeOrgId}/${stack}`;
  if (running.has(key)) throw commandRejected(`${stack} is already being restored. Wait for that to finish.`);
  running.add(key);
  try {
    const scope = await appRestoreScope(ctx, stack);
    const inputs = await gatherPlanInputs(ctx, scope, at);
    const plan = planAppRestore({ at, volumes: inputs.volumes, databases: inputs.databases });
    if (!plan.ok) throw commandRejected(refusalWords(stack, plan));
    const nodes = volumeNodes(ctx, plan, inputs.facts);
    await preflightDatabases(ctx, stack, plan);

    const audit = (status: 'succeeded' | 'failed', extra: Record<string, unknown>) =>
      writeAudit(ctx, {
        action: APP_RESTORE_AUDIT_ACTION,
        actorType: ctx.user ? 'user' : 'system',
        targetType: 'stack',
        targetId: stack,
        metadata: { at: new Date(at).toISOString(), status, skewMs: plan.skewMs, stopped: scope.stops.map((s) => s.service), ...extra },
      });
    let run: AppRestoreRun;
    try {
      run = await runAppRestore(plan.parts, bindSteps(ctx, { stack, scope, facts: inputs.facts, volumeNodes: nodes }, timing));
    } catch (e) {
      // The app would not stop: nothing was touched.
      await audit('failed', { error: e instanceof Error ? e.message : String(e), parts: [] });
      throw e;
    }
    const parts = run.parts.map((p) => ({ ...p, at: new Date(p.at).toISOString() }));
    await audit(run.ok ? 'succeeded' : 'failed', { parts, ...(run.error ? { error: run.error } : {}), ...(run.startError ? { startError: run.startError } : {}) });
    if (!run.ok) throw commandRejected(failureWords(stack, run));
    return view(stack, plan, scope, run);
  } finally {
    running.delete(key);
  }
}
