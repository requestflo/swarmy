import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Input, Label, Textarea, toast } from '@swarmy/ui';
import { Depth, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { handDeploy } from '@/components/deploy/deploy-handoff';
import { useComposeCheck } from './use-compose-check';
import { ComposeFeedback } from './compose-feedback';
import { ComposeAside } from './compose-aside';

const NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;
const PLACEHOLDER = `services:
  web:
    image: nginx:latest
    deploy:
      replicas: 2
    ports:
      - "8080:80"
`;

/** Name + compose (paste-first) + live validation. Owns the deploy mutation. */
export function DeployStackForm(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = React.useState('');
  const [compose, setCompose] = React.useState('');
  const [envSource, setEnvSource] = React.useState('');
  const check = useComposeCheck(compose);

  const deploy = useMutation(
    trpc.stacks.deployFromCompose.mutationOptions({
      onSuccess: (res, vars) => {
        // Translator warnings (ignored compose keys, undeclared volumes, legacy
        // volume reuse …) — surfaced once; the deploy itself went through.
        const notable = res.warnings.filter((w) => w.level !== 'info');
        if (notable.length > 0) {
          toast.info(
            notable.length === 1
              ? notable[0]!.message
              : `${notable.length} compose warnings — first: ${notable[0]!.message}`,
          );
        }
        void qc.invalidateQueries();
        // Land on the app page's "Deploying → It's live" state.
        handDeploy(vars.name, null, res.deployId);
        void navigate({ to: '/stacks/$name', params: { name: vars.name }, search: { deployed: 1 } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const nameOk = NAME_RE.test(name);
  const ready = nameOk && compose.trim().length > 0 && check.status !== 'error';

  const run = (): void =>
    deploy.mutate({ name, composeSource: compose, ...(envSource.trim() ? { envSource } : {}) });

  return (
    <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_400px]">
      <section aria-label="Your compose file" className="calm-card flex min-w-0 flex-col gap-4 px-5 py-5">
        <div className="grid gap-1.5">
          <Label htmlFor="stack-name">App name</Label>
          <Input id="stack-name" className="font-mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
          {name && !nameOk ? (
            <p className="text-tone-bad text-xs">Lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.</p>
          ) : (
            <p className="text-muted-foreground text-xs">Names the app and prefixes every service in it.</p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="compose-source">compose.yml</Label>
          <Textarea
            id="compose-source"
            className="min-h-72 font-mono text-xs"
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
          />
          <p className="text-muted-foreground text-xs">Paste it straight in. swarmy checks it as you type.</p>
        </div>
        <ComposeFeedback check={check} />
        <Depth at="controls">
          <div className="grid gap-1.5">
            <Label htmlFor="stack-env">Variables (.env)</Label>
            <Textarea
              id="stack-env"
              className="min-h-24 font-mono text-xs"
              value={envSource}
              onChange={(e) => setEnvSource(e.target.value)}
              placeholder={'TAG=1.4.2\nPUBLIC_URL=https://shop.example.com'}
              spellCheck={false}
            />
            <Tech>
              fills {'${VAR}'} and {'${VAR:-default}'} like the .env beside docker stack deploy · $$ for a literal $ · keep
              secrets in secret variables
            </Tech>
          </div>
        </Depth>
      </section>
      <aside className="flex min-w-0 flex-col gap-4">
        <ComposeAside
          name={name}
          compose={compose}
          envSource={envSource}
          check={check}
          ready={ready}
          pending={deploy.isPending}
          onDeploy={run}
        />
      </aside>
    </div>
  );
}
