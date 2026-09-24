import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Input, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PROVIDER_PRESETS, type RegistryProvider } from './registry-providers';

/** Mirror of `RegistryCredentialView` — no secret field exists on it. */
export interface RegistryCredential {
  id: string;
  prefix: string;
  provider: RegistryProvider;
  label: string | null;
  username: string;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

interface RegistryCredentialRowProps {
  cred: RegistryCredential;
  onChanged: () => void;
}

type Mode = 'idle' | 'test' | 'rotate' | 'delete';

/** One stored login: status, test (optional image), rotate token, delete (confirmed). */
export function RegistryCredentialRow({ cred, onChanged }: RegistryCredentialRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const [mode, setMode] = React.useState<Mode>('idle');
  const [value, setValue] = React.useState('');
  const done = (msg?: string) => () => {
    if (msg) toast.success(msg);
    setMode('idle');
    setValue('');
    onChanged();
  };
  const onError = (e: { message: string }) => toast.error(e.message);

  const test = useMutation(
    trpc.registryCredentials.test.mutationOptions({
      onSuccess: (r) => {
        if (r.ok) toast.success(r.message);
        else toast.error(`${r.status}: ${r.message}`);
        done()();
      },
      onError,
    }),
  );
  const rotate = useMutation(trpc.registryCredentials.update.mutationOptions({ onSuccess: done('Token rotated'), onError }));
  const remove = useMutation(trpc.registryCredentials.remove.mutationOptions({ onSuccess: done('Login deleted'), onError }));

  const tested = cred.lastTestOk === null ? null : cred.lastTestOk;
  return (
    <div className="bg-accent/40 grid gap-2 rounded-xl px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="mono-data truncate text-sm">{cred.prefix}</p>
          <p className="text-muted-foreground text-xs">
            {PROVIDER_PRESETS[cred.provider].label} · <span className="mono-data">{cred.username}</span> · token set
            {cred.label ? ` · ${cred.label}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <StatusBadge
            tone={tested === null ? 'neutral' : tested ? 'online' : 'offline'}
            label={tested === null ? 'Untested' : tested ? 'Works' : 'Failing'}
          />
          <Button variant="ghost" size="sm" onClick={() => setMode(mode === 'test' ? 'idle' : 'test')}>Test</Button>
          <Button variant="ghost" size="sm" onClick={() => setMode(mode === 'rotate' ? 'idle' : 'rotate')}>Rotate</Button>
          <Button variant="ghost" size="sm" onClick={() => setMode(mode === 'delete' ? 'idle' : 'delete')}>Delete</Button>
        </div>
      </div>
      {cred.lastTestMessage && mode === 'idle' && (
        <p className="text-muted-foreground text-xs">Last test: {cred.lastTestMessage}</p>
      )}
      {mode === 'test' && (
        <InlineAction
          input={<Input className="font-mono" placeholder={`${cred.prefix}/app:1.0 (optional)`} value={value} onChange={(e) => setValue(e.target.value)} />}
          label={test.isPending ? 'Testing…' : 'Run test'}
          disabled={test.isPending}
          onGo={() => test.mutate({ id: cred.id, image: value || undefined })}
        />
      )}
      {mode === 'rotate' && (
        <InlineAction
          input={<Input type="password" autoComplete="new-password" placeholder="New token" value={value} onChange={(e) => setValue(e.target.value)} />}
          label="Save token"
          disabled={!value || rotate.isPending}
          onGo={() => rotate.mutate({ id: cred.id, secret: value })}
        />
      )}
      {mode === 'delete' && (
        <InlineAction
          input={<p className="text-muted-foreground text-sm">Deploys pulling from {cred.prefix} will fail once their nodes lose the cached image.</p>}
          label="Delete login"
          destructive
          disabled={remove.isPending}
          onGo={() => remove.mutate({ id: cred.id })}
        />
      )}
    </div>
  );
}

interface InlineActionProps {
  input: React.ReactNode;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onGo: () => void;
}

function InlineAction({ input, label, disabled, destructive, onGo }: InlineActionProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">{input}</div>
      <Button size="sm" variant={destructive ? 'destructive' : 'default'} disabled={disabled} onClick={onGo}>
        {label}
      </Button>
    </div>
  );
}
