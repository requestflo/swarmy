import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cloneYaml } from '@swarmy/app-config';
import { Button, Input, Label, Switch } from '@swarmy/ui';
import { CodeView } from '@/components/calm';
import { Segmented } from '@/components/service-settings/settings-row';
import { useTRPC } from '@/integrations/trpc';
import type { AppEnvironment, GitApp } from '../gitops-types';
import { cloneSteps, dbOptions, maskOption, nameProblem, suggestName, type DbChoice } from './clone-model';

export interface CloneRequest {
  name: string;
  branch: string;
  database: boolean;
  mask: boolean;
}

/**
 * The "Clone as a new environment" fields (board Environments): name, the
 * branch it tracks, whether its database starts as a copy of the source's
 * newest backup, and the mask step when the app has one. Below them, what it
 * makes and the swarmy.yaml that would make it part of the file.
 */
export function CloneEnvForm({ app, from, pending, onClone }: { app: GitApp; from: AppEnvironment; pending: boolean; onClone: (r: CloneRequest) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const listable = !!app.connectionId && !!app.fullName;
  const branches = useQuery({
    ...trpc.gitConnections.branches.queryOptions({ connectionId: app.connectionId ?? '', repo: app.fullName ?? '' }),
    enabled: listable,
    staleTime: 60_000,
  });
  const [name, setName] = React.useState(() => suggestName(app));
  const [branch, setBranch] = React.useState(from.branch);
  const [db, setDb] = React.useState<DbChoice>('empty');
  const [mask, setMask] = React.useState(false);
  const masking = maskOption(app);
  const problem = nameProblem(app, name);
  const masked = db === 'copy' && masking.available && mask;
  const listId = React.useId();

  return (
    <form
      className="flex flex-col gap-4 px-4 pb-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && branch.trim()) onClone({ name, branch: branch.trim(), database: db === 'copy', mask: masked });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${listId}-name`}>Name</Label>
        <Input id={`${listId}-name`} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="h-9 max-w-xs font-mono text-[12.5px]" aria-invalid={!!problem} />
        {problem ? <span className="text-tone-warn text-xs">{problem}</span> : <span className="text-muted-foreground font-mono text-[11px]">stack {app.appName}-{name}</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${listId}-branch`}>Tracks branch</Label>
        <Input id={`${listId}-branch`} list={`${listId}-branches`} value={branch} onChange={(e) => setBranch(e.target.value)} className="h-9 max-w-xs font-mono text-[12.5px]" />
        <datalist id={`${listId}-branches`}>
          {(branches.data ?? []).map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
        <span className="text-muted-foreground text-xs">A push there redeploys it, like any environment.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Start its database</span>
        <Segmented label="Start its database" options={dbOptions(from.environment)} value={db} onChange={setDb} />
      </div>
      <div className="flex items-start gap-3">
        <Switch id={`${listId}-mask`} checked={masked} disabled={db !== 'copy' || !masking.available} onCheckedChange={setMask} className="mt-0.5" />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${listId}-mask`}>Mask personal data</Label>
          <span className="text-muted-foreground text-xs">{db === 'copy' ? masking.hint : 'only for a copied database'}</span>
        </div>
      </div>
      <ul aria-label="What it makes" className="flex flex-col gap-1.5">
        {cloneSteps(app, from, name, branch, db, masked).map(([t, m]) => (
          <li key={t} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[13px]">
            <span aria-hidden className="text-tone-ok w-3 font-mono font-bold">+</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t}</span>
            <span className="text-muted-foreground min-w-0 basis-full pl-5 font-mono text-[11px] break-words">{m}</span>
          </li>
        ))}
      </ul>
      <CodeView
        always
        title="In swarmy.yaml"
        tabs={[{ label: 'swarmy.yaml', code: cloneYaml(name || 'qa', branch || from.branch) }]}
        note="swarmy can’t write to your repo, so it lives in the dashboard until you add this to swarmy.yaml. From then on the file decides."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !!problem || !branch.trim()} className="pointer-coarse:min-h-11">
          {pending ? 'Cloning…' : `Clone as ${name || '…'}`}
        </Button>
        <span className="text-muted-foreground text-xs">Same gates as a push · audited</span>
      </div>
    </form>
  );
}
