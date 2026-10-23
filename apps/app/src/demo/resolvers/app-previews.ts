import type { DomainResolvers } from '../types';
import { appsState, demoHex, demoPlan, type DemoAction } from './apps';
import { pushDemoAudit } from './auditlog';

/**
 * `apps.createPreview` / `apps.teardownPreview` for the demo: a branch
 * preview is the same plan row a pushed branch makes (environment preview,
 * its own stack, the app's preview rules deciding whether it carries a copy
 * of the data); a teardown supersedes the rows, so `apps.list` drops it —
 * the shapes of createAppPreview / teardownAppPreview in apps.service.ts.
 */
const slug = (b: string): string => b.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const appPreviews: DomainResolvers = {
  handlers: {
    'apps.createPreview': (i, s) => {
      const { repoId, branch } = i as { repoId: string; branch: string };
      const st = appsState(s);
      const app = st.apps.find((a) => a.repoId === repoId);
      if (!app) throw new Error('That app is gone.');
      const stack = `${app.appName}-b-${slug(branch)}`;
      if (st.plans.some((p) => p.stack === stack && p.status !== 'superseded')) {
        return { action: 'skipped', stack, url: null, reason: `${branch} already has a preview` };
      }
      const rules = app.previewRules;
      const data = rules?.data;
      const actions: DemoAction[] = [
        { id: 'build:web', kind: 'build', phase: 2, gate: 'auto', reason: `Build web from ${branch}` },
        ...(data
          ? [{ id: 'resource.create:checkout', kind: 'resource.create', phase: 1, gate: 'auto' as const, reason: `create postgres "checkout" — a COPY of ${data.from}'s latest backup${data.scrub ? `, scrubbed by ${data.scrub}` : ''}; destroyed with the preview`, name: 'checkout', resourceType: 'postgres' }]
          : []),
        { id: 'service.deploy:web', kind: 'service.deploy', phase: 4, gate: 'auto', reason: 'Roll out web with the new image', name: 'web' },
      ];
      const now = new Date().toISOString();
      const pr = 100_000 + (parseInt(demoHex(5), 16) % 900_000);
      st.plans.push({
        ...demoPlan({
          id: `plan-${demoHex(8)}`,
          repoId,
          environment: 'preview',
          stack,
          sha: demoHex(40),
          trigger: 'branch',
          prNumber: pr,
          status: 'applied',
          actions,
          issues: [],
          outcomes: Object.fromEntries(actions.map((a) => [a.id, { status: 'done' as const, ...(a.kind === 'resource.create' ? { message: `restored 256 MB${data?.scrub ? ', scrub ran clean' : ''}` } : {}) }])),
          error: null,
          confirmedIds: [],
          createdAt: now,
          appliedAt: now,
        }),
        previewBranch: branch,
        ...(data ? { previewData: data } : {}),
      });
      return { action: 'deployed', stack, url: `https://${branch.replace(/\//g, '-')}.preview.northwind.dev`, reason: null };
    },

    'apps.teardownPreview': (i, s) => {
      const { repoId, prNumber } = i as { repoId: string; prNumber: number };
      const rows = appsState(s).plans.filter((p) => p.repoId === repoId && p.prNumber === prNumber && p.environment === 'preview');
      if (rows.length === 0) throw new Error('that preview is gone');
      for (const r of rows) r.status = 'superseded';
      const stack = rows[0]!.stack;
      pushDemoAudit(s, { action: 'app.preview.teardown', targetType: 'gitRepo', targetId: repoId, metadata: { stack, pr: prNumber } });
      return { stack };
    },
  },
};
