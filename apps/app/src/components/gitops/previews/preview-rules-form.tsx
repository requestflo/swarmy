import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { CodeView, toYaml } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { GitApp, PreviewRules } from '../gitops-types';
import { blockOf, draftFrom, draftProblem, type RulesDraft } from './preview-rules-edit';
import { PreviewRulesFields } from './preview-rules-fields';

/** The app's production stack — where saved rules live. */
const productionStack = (app: GitApp): string => app.environments.find((e) => e.environment === 'production')?.stack || (app.appName ?? '');

/**
 * Change the preview rules (board 68). swarmy can't write to your repo: when
 * swarmy.yaml sets `previews:`, the form makes the block to paste there and
 * saves nothing. Without one, Save keeps them on the app's production
 * services (`apps.setPreviewRules`, audited) until the file names `previews:`.
 */
export function PreviewRulesForm({ app, rules, onDone }: { app: GitApp; rules: PreviewRules | null | undefined; onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [d, setD] = React.useState<RulesDraft>(() => draftFrom(rules));
  const set = (p: Partial<RulesDraft>): void => setD((x) => ({ ...x, ...p }));
  const fileDecides = rules?.source === 'file';
  const problem = draftProblem(d);
  const block = blockOf(d);
  const save = useMutation(
    trpc.apps.setPreviewRules.mutationOptions({
      onSuccess: (_r, v) => {
        toast.success(v.rules ? 'Preview rules saved — the next preview follows them' : 'Saved rules cleared');
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const yaml = toYaml({ previews: block } as Parameters<typeof toYaml>[0]);
  const note = fileDecides
    ? `${app.configPath} sets previews:, so the file decides. Paste this over that block; the next push to ${app.branch} applies it.`
    : `Saved on ${productionStack(app)}’s services until ${app.configPath} has a previews: block — then the file decides. Add this to the file to keep the rules in git.`;

  return (
    <div className="flex flex-col gap-4">
      <PreviewRulesFields d={d} set={set} />
      {problem ? <p role="alert" className="text-tone-warn text-[12.5px]">{problem}</p> : null}
      <CodeView always title={fileDecides ? `Paste into ${app.configPath}` : 'The same rules in swarmy.yaml'} tabs={[{ label: 'swarmy.yaml', code: yaml }]} note={note} />
      <div className="flex flex-wrap items-center gap-2">
        {fileDecides ? (
          <Button variant="outline" onClick={onDone} className="pointer-coarse:min-h-11">
            Done
          </Button>
        ) : (
          <>
            <Button variant="outline" disabled={Boolean(problem) || save.isPending} onClick={() => save.mutate({ stack: productionStack(app), rules: block })} className="pointer-coarse:min-h-11">
              {save.isPending ? 'Saving…' : 'Save rules'}
            </Button>
            {rules?.source === 'dashboard' ? (
              <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ stack: productionStack(app), rules: null })} className="pointer-coarse:min-h-11">
                Clear saved rules
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onDone} className="pointer-coarse:min-h-11">
              Cancel
            </Button>
          </>
        )}
        <span className="text-muted-foreground text-xs">{fileDecides ? 'Nothing is saved here' : 'Audited · applies to the next preview'}</span>
      </div>
    </div>
  );
}
