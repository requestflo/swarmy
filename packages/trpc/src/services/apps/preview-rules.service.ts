/**
 * `apps.setPreviewRules` (board 68): save — or clear — the preview rules of
 * a git app whose swarmy.yaml has no `previews:` block. They are stamped on
 * every service of the production stack (`swarmy.previews.rules`, see
 * preview-rules.ts) under production's apply lock, so a deploy in flight
 * can't put back the old label; the next plan reads them, and production's
 * compose carries them from then on. When the file sets `previews:` the
 * file decides and this refuses: the dashboard shows the YAML to change.
 * `service.configure` on the production stack (the router); audited
 * `app.previews.rules`.
 */
import { PRODUCTION, desiredPreviews, environmentStack, type DesiredApp, type PreviewsBlock } from '@swarmy/app-config';
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { commandRejected, mapDispatchError, notFound } from '../../errors';
import { lockAppEnvironment, previewRulesOf, type AppPreviewRules } from '../apps.service';
import { writeAudit } from '../audit.service';
import { resolveManagerNode } from '../dispatch.service';
import { APP_STACK_LABEL } from './live';
import { PREVIEW_RULES_LABEL, fileSetsPreviews } from './preview-rules';

export async function setPreviewRules(
  ctx: OrgContext,
  input: { stack: string; rules: PreviewsBlock | null },
): Promise<AppPreviewRules | null> {
  const repo = await ctx.db.gitRepo.findFirst({ where: { orgId: ctx.activeOrgId, appName: input.stack, serviceId: null } });
  if (!repo?.appName || environmentStack(repo.appName, PRODUCTION) !== input.stack) throw notFound('git app', input.stack);
  const rows = await ctx.db.appPlan.findMany({
    where: { repoId: repo.id, environment: PRODUCTION, prNumber: 0 },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { desiredJson: true },
  });
  const planned = (rows.find((r) => r.desiredJson != null)?.desiredJson as DesiredApp | undefined)?.previews;
  if (fileSetsPreviews(planned)) {
    throw commandRejected(`${repo.configPath} sets previews:, so the file decides — change the rules there and push`);
  }
  return lockAppEnvironment(repo.id, PRODUCTION, async () => {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    const mine = buildInventory(services, containers).services.filter((s) => s.labels[APP_STACK_LABEL] === input.stack);
    if (!mine.length) throw commandRejected(`${input.stack} isn't running yet — the rules are kept on its services, so deploy production first`);
    const node = await resolveManagerNode(ctx);
    const value = input.rules ? JSON.stringify(input.rules) : null;
    try {
      for (const s of mine) {
        await ctx.hub.dispatch(node.id, 'service.updateLabels', {
          service: s.name,
          add: value ? { [PREVIEW_RULES_LABEL]: value } : {},
          removeKeys: value ? [] : [PREVIEW_RULES_LABEL],
        });
      }
    } catch (e) {
      throw mapDispatchError(e);
    }
    await writeAudit(ctx, {
      action: 'app.previews.rules',
      targetType: 'gitRepo',
      targetId: repo.id,
      metadata: { stack: input.stack, rules: input.rules, cleared: !input.rules, services: mine.length },
    });
    return previewRulesOf({ previews: desiredPreviews({}, input.rules) });
  });
}
