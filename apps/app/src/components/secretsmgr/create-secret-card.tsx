import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Collapsible, CollapsibleContent, Input, Label, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { SecretNameTemplates } from './secret-name-templates';
import type { RevealedSecret } from './secret-reveal-banner';
import { SecretValueField } from './secret-value-field';
import { StackServiceSelect } from './stack-service-select';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

interface CreateSecretCardProps {
  stack: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after create (and optional attach) so the reveal-once banner shows. */
  onCreated: (revealed: RevealedSecret) => void;
}

/**
 * Inline create card (no modal): name + write-only value, with an optional
 * immediate attach onto one of THIS stack's services. Template chips prefill
 * common names only — the value is always yours.
 */
export function CreateSecretCard({
  stack,
  open,
  onOpenChange,
  onCreated,
}: CreateSecretCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [family, setFamily] = React.useState('');
  const [value, setValue] = React.useState('');
  const [service, setService] = React.useState('');

  const create = useMutation(trpc.secrets.create.mutationOptions());
  const attach = useMutation(trpc.secrets.attach.mutationOptions());
  const pending = create.isPending || attach.isPending;
  const ready = NAME_RE.test(family.trim()) && family.trim().length <= 56 && value.length > 0;

  const submit = async (): Promise<void> => {
    try {
      const r = await create.mutateAsync({ family: family.trim(), value, stack });
      if (service) {
        try {
          await attach.mutateAsync({ family: r.family, service });
          toast.success(`${r.family} created and mounted into ${service}`);
        } catch (e) {
          toast.error(`${r.family} created, but attaching failed: ${(e as Error).message}`);
        }
      } else {
        toast.success(`Secret ${r.family} created (v${r.version})`);
      }
      onCreated({ family: r.family, version: r.version, value });
      setFamily('');
      setValue('');
      setService('');
      onOpenChange(false);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="card-pop space-y-4 p-5">
          <div>
            <p className="text-sm font-bold">New secret</p>
            <p className="text-muted-foreground text-xs">
              Stored as a versioned Docker secret, mounted at{' '}
              <code className="mono-data">/run/secrets/&lt;name&gt;</code>. Write-only, forever.
            </p>
          </div>
          <SecretNameTemplates value={family} onPick={setFamily} />
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label className="mono-label">Name</Label>
              <Input
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                placeholder="DATABASE_URL"
                className="mono-data"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <StackServiceSelect
              stack={stack}
              value={service}
              onChange={setService}
              label="Attach to service (optional)"
              emptyHint="No services in this stack yet — attach later."
            />
          </div>
          <SecretValueField value={value} onChange={setValue} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!ready || pending}>
              {pending ? 'Creating…' : service ? 'Create & attach' : 'Create secret'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
