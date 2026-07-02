import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import type { AiKeyMintResult } from '@swarmy/core';
import {
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Mint dialog with limits; on success the key is revealed exactly ONCE. */
export function MintKeyDialog(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [rpm, setRpm] = React.useState('');
  const [budget, setBudget] = React.useState('');
  const [result, setResult] = React.useState<AiKeyMintResult | null>(null);

  const mint = useMutation(
    trpc.ai.mintKey.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        toast.success(`Key ${r.name} minted`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const close = (next: boolean): void => {
    setOpen(next);
    if (!next) {
      setName('');
      setRpm('');
      setBudget('');
      setResult(null);
    }
  };

  const submit = (): void => {
    mint.mutate({
      name: name.trim(),
      ...(rpm.trim() ? { rpm: Number(rpm) } : {}),
      ...(budget.trim() ? { dailyBudgetUsd: Number(budget) } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="size-4" /> Mint key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Save this key now.</DialogTitle>
              <DialogDescription>
                It&apos;s shown once — swarmy keeps only a hash. Point your app at the gateway URL
                and send the key as the <code className="mono-data">x-swarmy-ai-key</code> header.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <KeyRoundIcon className="text-muted-foreground size-4 shrink-0" />
                  <code className="mono-data truncate text-xs">{result.key}</code>
                </div>
                <CopyButton value={result.key} />
              </div>
              <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
                <code className="mono-data truncate text-xs">{result.gatewayUrl}</code>
                <CopyButton value={result.gatewayUrl} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Mint a virtual key</DialogTitle>
              <DialogDescription>
                Optional limits keep one app from burning the budget: requests per minute and an
                estimated daily spend cap.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label className="mono-label">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="web-app" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="mono-label">Requests / min</Label>
                  <Input type="number" min={1} value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="60" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="mono-label">Daily budget (USD)</Label>
                  <Input type="number" min={0.01} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="5.00" />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={submit} disabled={mint.isPending || !name.trim()}>
                {mint.isPending ? 'Minting…' : 'Mint key'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
