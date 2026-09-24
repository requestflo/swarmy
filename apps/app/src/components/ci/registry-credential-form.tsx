import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PROVIDER_ORDER, PROVIDER_PRESETS, type RegistryProvider } from './registry-providers';

interface RegistryCredentialFormProps {
  onSaved: () => void;
  onCancel: () => void;
}

/** Add (or rotate by prefix) a registry login. The token is write-only. */
export function RegistryCredentialForm({ onSaved, onCancel }: RegistryCredentialFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const [provider, setProvider] = React.useState<RegistryProvider>('ghcr');
  const [prefix, setPrefix] = React.useState(PROVIDER_PRESETS.ghcr.prefix);
  const [username, setUsername] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [image, setImage] = React.useState('');
  const preset = PROVIDER_PRESETS[provider];

  const save = useMutation(
    trpc.registryCredentials.upsert.mutationOptions({
      onSuccess: () => {
        toast.success('Registry login saved — deploys and builds pulling from it now authenticate');
        onSaved();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const test = useMutation(
    trpc.registryCredentials.test.mutationOptions({
      onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(`${r.status}: ${r.message}`)),
      onError: (e) => toast.error(e.message),
    }),
  );

  const ready = prefix.trim() && username.trim() && secret;
  const pickProvider = (v: string): void => {
    const p = v as RegistryProvider;
    setProvider(p);
    setPrefix(PROVIDER_PRESETS[p].prefix);
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate({ prefix, username, secret, provider });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider">
          <Select value={provider} onValueChange={pickProvider}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {PROVIDER_ORDER.map((p) => (
                <SelectItem key={p} value={p}>{PROVIDER_PRESETS[p].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Registry" hint={preset.prefixHint}>
          <Input className="font-mono" value={prefix} placeholder={preset.prefixHint} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label="Username" hint={preset.usernameHint}>
          <Input className="font-mono" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Token" hint={preset.secretHint}>
          <Input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      </div>
      <Field label="Test against an image (optional)" hint="Checks the login can pull this image's manifest.">
        <Input className="font-mono" value={image} placeholder={`${prefix || 'ghcr.io/acme'}/app:1.0`} onChange={(e) => setImage(e.target.value)} />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ready || test.isPending}
          onClick={() => test.mutate({ prefix, username, secret, image: image || undefined })}
        >
          {test.isPending ? 'Testing…' : 'Test'}
        </Button>
        <Button type="submit" size="sm" disabled={!ready || save.isPending}>Save</Button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
