import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Textarea, toast } from '@swarmy/ui';
import { MAX_TRUSTED_KEYS } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';

/**
 * Keys you trust besides your workspace's own: a vendor's or another team's
 * cosign public key. An image signed with one passes "Only deploy signed
 * images", and its part's sign chip on the app canvas says "signed · trusted
 * key". Public keys only; adding and removing are admin-only and audited.
 */
export function TrustedKeysCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery(trpc.registryPolicy.getPolicy.queryOptions());
  const keys = policy.data?.trustedKeys ?? [];
  const [name, setName] = React.useState('');
  const [pem, setPem] = React.useState('');
  const save = useMutation(
    trpc.registryPolicy.addTrustedKey.mutationOptions({
      onSuccess: () => {
        setName('');
        setPem('');
        void qc.invalidateQueries({ queryKey: trpc.registryPolicy.getPolicy.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.registryPolicy.removeTrustedKey.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.registryPolicy.getPolicy.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const full = keys.length >= MAX_TRUSTED_KEYS;

  return (
    <Card className="calm-card border-0">
      <CardHeader>
        <CardTitle className="text-base">Keys you trust</CardTitle>
        <CardDescription>
          Images signed with one of these count as signed, as well as those signed with your own key.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {keys.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet. Only your workspace’s own key counts.</p>
        ) : (
          <ul className="grid gap-1.5">
            {keys.map((k) => (
              <li key={k.name} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{k.name}</p>
                  <p className="text-muted-foreground font-mono text-[11px]">sha256 {k.fingerprint}</p>
                </div>
                <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate({ name: k.name })}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ name, publicKey: pem });
          }}
        >
          <Label htmlFor="trusted-key-name">Add a key</Label>
          <Input id="trusted-key-name" placeholder="Name, e.g. Acme release" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <Textarea
            aria-label="Public key (PEM)"
            placeholder="Paste the public key (PEM): the BEGIN PUBLIC KEY block from cosign.pub"
            className="font-mono text-[11.5px]"
            rows={4}
            value={pem}
            onChange={(e) => setPem(e.target.value)}
          />
          <Button type="submit" variant="outline" size="sm" className="justify-self-start" disabled={full || !name.trim() || !pem.trim() || save.isPending}>
            {full ? `${MAX_TRUSTED_KEYS} keys is the most` : save.isPending ? 'Adding…' : 'Trust this key'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
