import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, toast } from '@swarmy/ui';
import {
  API_KEY_EXPIRIES,
  API_KEY_EXPIRY_LABEL,
  API_KEY_PRESETS,
  describeApiKey,
  type ApiKeyExpiry,
  type ApiKeyPreset,
} from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { Section, Tech } from '@/components/calm';
import { Segmented } from '@/components/domains/segmented';
import { AppChips } from './app-chips';
import { IssuedSecretPanel } from './issued-secret-panel';
import { PresetCards } from './preset-cards';

function tryIt(key: string, apps: string[] | null): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -H "Authorization: Bearer ${key}" ${origin}/api/v1/${apps ? 'stacks' : 'services'}`;
}

/** The page's one coral action: name a key, pick what it can do, where, and for how long. Shown once. */
export function NewKeyPanel(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [preset, setPreset] = React.useState<ApiKeyPreset>('deploy');
  const [apps, setApps] = React.useState<string[] | null>(null);
  const [expiry, setExpiry] = React.useState<ApiKeyExpiry>('90d');
  const [issued, setIssued] = React.useState<{ key: string; apps: string[] | null } | null>(null);
  const create = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (res) => {
        setIssued({ key: res.key, apps: res.stackNames });
        setName('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const submit = (): void => {
    if (!name.trim()) return setNameError('Name it so you can tell it apart later, e.g. github-actions.');
    setNameError(null);
    create.mutate({ name: name.trim(), preset, stackNames: apps, expiry });
  };

  if (issued) {
    return (
      <Section title="New key" hint="shown once">
        <IssuedSecretPanel
          title="Copy it now. It won’t be shown again."
          lines={[{ label: 'API key', value: issued.key }, { label: 'Try it', value: tryIt(issued.key, issued.apps) }]}
        />
        <Button variant="outline" className="w-fit pointer-coarse:min-h-11" onClick={() => setIssued(null)}>
          Done
        </Button>
      </Section>
    );
  }

  return (
    <Section id="new-key" title="New key" hint="admins only">
      <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input id="key-name" value={name} aria-invalid={!!nameError} placeholder="github-actions" className="pointer-coarse:min-h-11" onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }} />
          {nameError ? <p className="text-tone-bad text-xs">{nameError}</p> : null}
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">It can</span>
          <PresetCards value={preset} onChange={setPreset} />
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">On these apps</span>
          <AppChips multi value={apps} onChange={setApps} label="On these apps" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Expires</span>
          <Segmented mono label="Expires" value={expiry} onChange={setExpiry} options={API_KEY_EXPIRIES.map((e) => ({ value: e, label: API_KEY_EXPIRY_LABEL[e] }))} />
        </div>
        <div className="bg-muted/50 rounded-[10px] border px-3.5 py-3" aria-live="polite">
          <p className="calm-eyebrow mb-1">This key can…</p>
          <p className="text-[13.5px] leading-snug">{describeApiKey({ preset, stackNames: apps, expiry })}</p>
          <Tech>{`scopes ${API_KEY_PRESETS[preset].scopes.join(',')} · stack_names ${apps ? JSON.stringify(apps) : 'null'} · expiry ${expiry}`}</Tech>
        </div>
        <Button type="submit" className="w-full pointer-coarse:min-h-11" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create key'}
        </Button>
      </form>
    </Section>
  );
}
