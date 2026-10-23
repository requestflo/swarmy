import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, cn, toast } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { GitApp } from '../gitops-types';
import { dataWords, duration } from './previews-model';

const chip = 'h-8 rounded-full border px-3 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11';

/**
 * New preview from a branch — no pull request needed (`apps.createPreview`,
 * the trial-deploy path): pick a branch the repo has (`gitConnections.branches`)
 * that has no preview or environment yet, see what it makes, create it.
 */
export function NewPreview({ app, onCreated }: { app: GitApp; onCreated: (stack: string) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const listable = !!app.connectionId && !!app.fullName;
  const branches = useQuery({
    ...trpc.gitConnections.branches.queryOptions({ connectionId: app.connectionId ?? '', repo: app.fullName ?? '' }),
    enabled: listable,
    staleTime: 60_000,
  });
  const taken = new Set([app.branch, ...app.environments.map((e) => e.branch), ...app.previews.map((p) => p.branch).filter(Boolean)]);
  const free = (branches.data ?? []).map((b) => b.name).filter((n) => !taken.has(n));
  const [pick, setPick] = React.useState('');
  const branch = listable ? (free.includes(pick) ? pick : (free[0] ?? '')) : pick.trim();
  const create = useMutation(
    trpc.apps.createPreview.mutationOptions({
      onSuccess: (r) => {
        if (r.action === 'deployed') {
          toast.success(`${branch} is up${r.url ? ` at ${r.url}` : ''}`);
          if (r.stack) onCreated(r.stack);
        } else toast.error(`Preview ${r.action}: ${r.reason ?? 'no reason given'}`);
        void qc.invalidateQueries({ queryKey: trpc.apps.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rules = app.previewRules;
  const plan: Array<[string, string]> = branch
    ? [
        [`Build ${branch}`, `${app.configPath} · same build as a push`],
        [`Its own copy of ${app.appName ?? 'the app'}`, 'a stack of its own, same swarmy.yaml'],
        ['Database', rules ? dataWords(rules) : 'as swarmy.yaml says'],
        ['Kept for', rules?.ttlSeconds ? `${duration(rules.ttlSeconds)} after the last push` : 'until the branch is deleted'],
      ]
    : [];

  return (
    <Section title="New preview from a branch" hint="no pull request needed">
      {listable ? (
        branches.isPending ? (
          <div aria-hidden className="shimmer-line h-8 w-2/3 rounded-full" />
        ) : free.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">Every branch already has a preview or an environment. Push a new branch to see it here.</p>
        ) : (
          <div role="group" aria-label="Branch" className="flex flex-wrap gap-1.5">
            {free.map((b) => (
              <button key={b} type="button" aria-pressed={b === branch} onClick={() => setPick(b)} className={cn(chip, b === branch ? 'border-foreground/40 bg-surface-2 dark:bg-accent font-semibold' : 'border-border text-muted-foreground hover:text-foreground')}>
                {b}
              </button>
            ))}
          </div>
        )
      ) : (
        <Input aria-label="Branch" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="feature/checkout-v2" className="h-9 max-w-xs font-mono text-[12.5px]" />
      )}
      {plan.length ? (
        <ul aria-label="What it makes" className="flex flex-col gap-1.5">
          {plan.map(([t, m]) => (
            <li key={t} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[13px]">
              <span aria-hidden className="text-tone-ok w-3 font-mono font-bold">+</span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t}</span>
              <span className="text-muted-foreground min-w-0 basis-full pl-5 font-mono text-[11px] break-words sm:basis-auto sm:pl-0 sm:text-right">{m}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!branch || create.isPending} onClick={() => create.mutate({ repoId: app.repoId, branch })} className="pointer-coarse:min-h-11">
          {create.isPending ? 'Building…' : branch ? `Create preview of ${branch}` : 'Pick a branch'}
        </Button>
        <span className="text-muted-foreground text-xs">Same gates as a deploy · audited · push it first, swarmy builds from git</span>
      </div>
    </Section>
  );
}
