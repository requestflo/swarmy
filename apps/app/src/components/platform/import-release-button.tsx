import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UploadIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Textarea, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Offline bundle / air-gapped path: paste or load platform.json + platform.json.sig. */
export function ImportReleaseButton(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [manifest, setManifest] = React.useState('');
  const [signature, setSignature] = React.useState('');
  const imp = useMutation(
    trpc.platform.importRelease.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Release ${r.manifest?.version ?? ''} imported and verified`);
        setOpen(false);
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
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <UploadIcon className="size-3.5" /> Import release
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a release</DialogTitle>
          <DialogDescription>
            For clusters without internet access: the <span className="mono-data">platform.json</span> and{' '}
            <span className="mono-data">platform.json.sig</span> from an offline bundle. They are checked against the swarmy
            release key before anything is stored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Label htmlFor="imp-manifest">platform.json</Label>
          <input id="imp-manifest" type="file" accept=".json,application/json" onChange={load(setManifest)} className="text-xs" />
          <Textarea aria-label="platform.json contents" rows={4} value={manifest} onChange={(e) => setManifest(e.target.value)} className="mono-data text-xs" />
          <Label htmlFor="imp-sig">platform.json.sig</Label>
          <input id="imp-sig" type="file" onChange={load(setSignature)} className="text-xs" />
          <Textarea aria-label="platform.json.sig contents" rows={2} value={signature} onChange={(e) => setSignature(e.target.value)} className="mono-data text-xs" />
        </div>
        <DialogFooter>
          <Button onClick={() => imp.mutate({ manifest, signature })} disabled={!manifest || !signature || imp.isPending}>
            Verify and import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
