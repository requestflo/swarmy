import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, XIcon } from 'lucide-react';
import type { AiKeyMintResult } from '@swarmy/core';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface MintKeyCardProps {
  /** Receives the mint result ONCE — render it in a KeyRevealBanner. */
  onMinted: (result: AiKeyMintResult) => void;
}

/** Inline expanding mint form (no modal); limits are optional guardrails. */
export function MintKeyCard({ onMinted }: MintKeyCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [rpm, setRpm] = React.useState('');
  const [budget, setBudget] = React.useState('');

  const mint = useMutation(
    trpc.ai.mintKey.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Key ${r.name} minted`);
        onMinted(r);
        setOpen(false);
        setName('');
        setRpm('');
        setBudget('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    mint.mutate({
      name: name.trim(),
      ...(rpm.trim() ? { rpm: Number(rpm) } : {}),
      ...(budget.trim() ? { dailyBudgetUsd: Number(budget) } : {}),
    });
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col items-end sm:w-auto">
      <CollapsibleTrigger asChild>
        <Button variant={open ? 'outline' : 'default'}>
          {open ? <XIcon className="size-4" /> : <PlusIcon className="size-4" />}
          {open ? 'Cancel' : 'Mint key'}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full sm:w-[26rem]">
        <div className="bg-muted/30 mt-3 space-y-3 rounded-xl border p-4 text-left">
          <p className="text-muted-foreground text-xs">
            Optional limits keep one app from burning the budget: requests per minute and an
            estimated daily spend cap.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="mint-key-name" className="mono-label">
              Name
            </Label>
            <Input
              id="mint-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="web-app"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="mint-key-rpm" className="mono-label">
                Requests / min
              </Label>
              <Input
                id="mint-key-rpm"
                type="number"
                min={1}
                value={rpm}
                onChange={(e) => setRpm(e.target.value)}
                placeholder="60"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mint-key-budget" className="mono-label">
                Daily budget (USD)
              </Label>
              <Input
                id="mint-key-budget"
                type="number"
                min={0.01}
                step="0.01"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="5.00"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={mint.isPending || !name.trim()}>
              {mint.isPending ? 'Minting…' : 'Mint key'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
