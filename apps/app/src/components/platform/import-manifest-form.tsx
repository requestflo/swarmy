import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Label, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Just `platform.json` + `platform.json.sig` — for when the bundle's images
 * are already in the registry (its `push.sh` was run on a manager).
 */
export function ImportManifestForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [manifest, setManifest] = React.useState('');
  const [signature, setSignature] = React.useState('');
  const imp = useMutation(
    trpc.platform.importRelease.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Release ${r.manifest?.version ?? ''} imported and verified`);
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const load = (set: (s: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void f.text().then(set);
  };
  return (
    <div className="grid gap-3">
      <Label htmlFor="imp-manifest">platform.json</Label>
      <input id="imp-manifest" type="file" accept=".json,application/json" onChange={load(setManifest)} className="text-xs" />
      <Textarea aria-label="platform.json contents" rows={4} value={manifest} onChange={(e) => setManifest(e.target.value)} className="mono-data text-xs" />
      <Label htmlFor="imp-sig">platform.json.sig</Label>
      <input id="imp-sig" type="file" onChange={load(setSignature)} className="text-xs" />
      <Textarea aria-label="platform.json.sig contents" rows={2} value={signature} onChange={(e) => setSignature(e.target.value)} className="mono-data text-xs" />
      <div className="flex justify-end">
        <Button onClick={() => imp.mutate({ manifest, signature })} disabled={!manifest || !signature || imp.isPending}>
          Verify and import
        </Button>
      </div>
    </div>
  );
}
