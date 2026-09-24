import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon, RocketIcon } from 'lucide-react';
import { Button, Input, Label, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useComposeCheck } from './use-compose-check';
import { ComposeFeedback } from './compose-feedback';

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
        toast.success(`Stack ${vars.name} deploying`);
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
        void navigate({ to: '/stacks/$name', params: { name: vars.name } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const nameOk = NAME_RE.test(name);
  const ready = nameOk && compose.trim().length > 0 && check.status !== 'error';

  return (
    <div className="grid gap-5">
      <section className="card-pop grid gap-4 p-6">
        <div className="grid gap-1.5">
          <Label htmlFor="stack-name" className="mono-label">
            Stack name
          </Label>
          <Input
            id="stack-name"
            className="font-mono"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-app"
          />
          {name && !nameOk ? (
            <p className="text-status-offline text-xs">
              Lowercase letters, digits, dots, dashes and underscores — starting with a letter or
              digit.
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Names the stack and prefixes every service in it.
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="compose-source" className="mono-label">
            compose.yml
          </Label>
          <Textarea
            id="compose-source"
            className="min-h-72 font-mono text-xs"
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
          />
          <p className="text-muted-foreground text-xs">
            Paste it straight in — we check it as you type.
          </p>
        </div>
        <ComposeFeedback check={check} />
        <div className="grid gap-1.5">
          <Label htmlFor="stack-env" className="mono-label">
            Variables (.env)
          </Label>
          <Textarea
            id="stack-env"
            className="min-h-24 font-mono text-xs"
            value={envSource}
            onChange={(e) => setEnvSource(e.target.value)}
            placeholder={'TAG=1.4.2\nPUBLIC_URL=https://shop.example.com'}
            spellCheck={false}
          />
          <p className="text-muted-foreground text-xs">
            Fills <code>{'${VAR}'}</code>, <code>{'${VAR:-default}'}</code> and friends in the compose file, like
            the <code>.env</code> next to <code>docker stack deploy</code>. Use <code>$$</code> for a literal{' '}
            <code>$</code>. Keep secrets in secret variables instead.
          </p>
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
        <Button
          type="button"
          variant="ghost"
          className="rounded-full font-bold"
          onClick={() => void navigate({ to: '/' })}
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="rounded-full font-bold shadow-[0_8px_24px_-8px_var(--primary)] transition-transform hover:scale-[1.03]"
          disabled={!ready || deploy.isPending}
          onClick={() => deploy.mutate({ name, composeSource: compose, ...(envSource.trim() ? { envSource } : {}) })}
        >
          {deploy.isPending ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <RocketIcon className="size-4" />
          )}
          Deploy stack
        </Button>
      </div>
    </div>
  );
}
