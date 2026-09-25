import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Section } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { IssuedSecretPanel } from './issued-secret-panel';

function curlExample(key: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `curl -H "Authorization: Bearer ${key}" ${origin}/api/v1/services`;
}

/** Make an org API key; the secret is shown once. */
export function NewKeyForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [canWrite, setCanWrite] = React.useState(false);
  const [issued, setIssued] = React.useState<string | null>(null);
  const create = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (res) => {
        setIssued(res.key);
        setName('');
        setCanWrite(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const submit = (): void => {
    if (!name.trim()) return setNameError('Name it so you can tell it apart later, e.g. ci-terraform.');
    setNameError(null);
    create.mutate({ name: name.trim(), scopes: canWrite ? ['read', 'write'] : ['read'] });
  };
  return (
    <Section title="New API key" hint="it acts as you, inside this workspace">
      {issued ? (
        <>
          <IssuedSecretPanel title="Copy it now. It won’t be shown again." lines={[{ label: 'API key', value: issued }, { label: 'Try it', value: curlExample(issued) }]} />
          <Button variant="outline" className="w-fit pointer-coarse:min-h-11" onClick={onDone}>Done</Button>
        </>
      ) : (
        <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="grid min-w-[14rem] flex-1 gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" value={name} aria-invalid={!!nameError} placeholder="ci-terraform" onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }} />
            {nameError ? <p className="text-tone-bad text-xs">{nameError}</p> : null}
          </div>
          <div className="flex items-center gap-2 pb-2">
            <QuietSwitch id="key-write" checked={canWrite} onCheckedChange={setCanWrite} />
            <Label htmlFor="key-write">Can change things (not just read)</Label>
          </div>
          <Button type="submit" variant="outline" className="pointer-coarse:min-h-11" disabled={create.isPending}>
            {create.isPending ? 'Making…' : 'Make the key'}
          </Button>
          <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={onDone}>Cancel</Button>
        </form>
      )}
    </Section>
  );
}
