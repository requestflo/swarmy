import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SparklesIcon, XIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface StackAiGrantFormProps {
  stack: string;
  /** True when a stack key already exists — granting again rotates it. */
  hasGrant: boolean;
  onGranted: (reveal: { key: string; gatewayUrl: string }) => void;
}

/**
 * Inline expanding grant form: pick which services get gateway env wired in,
 * then mint the stack-tagged key. The plaintext lands in the caller's
 * REVEAL-ONCE banner — never a modal.
 */
export function StackAiGrantForm({ stack, hasGrant, onGranted }: StackAiGrantFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 5_000 });

  const grant = useMutation(
    trpc.ai.grantStackAccess.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${stack} granted — key ${r.keyName} minted`);
        onGranted({ key: r.key, gatewayUrl: r.gatewayUrl });
        setOpen(false);
        setSelected([]);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const services = (inventory.data?.services ?? [])
    .filter((s) => s.stack === stack)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));

  const toggle = (name: string): void =>
    setSelected((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant={open ? 'outline' : hasGrant ? 'outline' : 'default'} className="gap-2">
          {open ? <XIcon className="size-4" /> : <SparklesIcon className="size-4" />}
          {open ? 'Cancel' : hasGrant ? 'Rotate key / attach services' : 'Grant AI access'}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-muted/30 mt-3 space-y-3 rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">
            Mints a <span className="mono-data">stack:{stack}</span> virtual key (shown once
            {hasGrant ? '; the current key is rotated out' : ''}) and wires each chosen service with{' '}
            <span className="mono-data">AI_GATEWAY_URL</span> + its own key in a Docker secret.
          </p>
          <div>
            <p className="mono-label">Wire services (optional)</p>
            {services.length === 0 ? (
              <p className="text-muted-foreground text-xs">No services in this stack yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {services.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggle(name)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                      selected.includes(name)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={grant.isPending}
              onClick={() => grant.mutate({ stack, ...(selected.length > 0 ? { services: selected } : {}) })}
            >
              {grant.isPending ? 'Granting…' : hasGrant ? 'Rotate & grant' : 'Grant access'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
