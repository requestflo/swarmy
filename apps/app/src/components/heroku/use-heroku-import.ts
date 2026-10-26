import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { HerokuImportSource } from '@swarmy/core';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { toSource } from './heroku-import-model';
import { EMPTY_DRAFT, type HerokuDeployResult, type HerokuImportView, type HerokuSourceDraft } from './heroku-types';

/**
 * Import from Heroku, as one page's state: the form → plan → Deploy, then
 * the data copy. The token (or the pasted config, with its values) lives in
 * this component's memory only — sent with each call, never saved — and is
 * dropped when the page goes.
 */
export function useHerokuImport() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<HerokuSourceDraft>(EMPTY_DRAFT);
  const [source, setSource] = React.useState<HerokuImportSource | null>(null);
  const [view, setView] = React.useState<HerokuImportView | null>(null);
  const [deployed, setDeployed] = React.useState<HerokuDeployResult | null>(null);

  const plan = useMutation(
    trpc.herokuImport.plan.mutationOptions({
      onSuccess: (v) => setView(v),
      onError: (e) => toast.error(e.message),
    }),
  );
  const deploy = useMutation(
    trpc.herokuImport.deploy.mutationOptions({
      onSuccess: (r) => {
        setDeployed(r);
        void qc.invalidateQueries();
        const failed = r.steps.filter((s) => s.status === 'failed').length;
        if (failed) toast.error(`${failed} step${failed === 1 ? '' : 's'} didn’t go through — see below.`);
        else toast.success(`${r.stack} is set up on swarmy.`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const review = (): void => {
    const r = toSource(draft);
    if ('error' in r) return void toast.error(r.error);
    setSource(r.source);
    setDeployed(null);
    plan.mutate({ source: r.source });
  };
  const rename = (next: string): void => {
    if (source && next && next !== view?.app) plan.mutate({ source, name: next });
  };
  const run = (): void => {
    if (source && view && !deploy.isPending) deploy.mutate({ source, stack: view.app });
  };
  const restart = (): void => {
    setView(null);
    setDeployed(null);
    setSource(null);
  };

  return {
    draft,
    setField: <K extends keyof HerokuSourceDraft>(k: K, v: HerokuSourceDraft[K]) => setDraft((d) => ({ ...d, [k]: v })),
    fill: (patch: Partial<HerokuSourceDraft>) => setDraft((d) => ({ ...d, ...patch })),
    rename,
    review,
    reviewing: plan.isPending,
    source,
    view,
    deploy: run,
    deploying: deploy.isPending,
    deployed,
    restart,
  };
}

export type HerokuImport = ReturnType<typeof useHerokuImport>;
