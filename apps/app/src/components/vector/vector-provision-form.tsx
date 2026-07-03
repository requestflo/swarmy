import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BoxIcon } from 'lucide-react';
import type { VectorProvisionResult } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CreateVectorFields, EMPTY_VECTOR_DRAFT, type VectorDraft } from './create-vector-fields';

interface VectorProvisionFormProps {
  /** The workspace stack — provisioning always lands here. */
  stack: string;
  /** Fired with the reveal-once API key; the section shows the banner. */
  onProvisioned: (result: VectorProvisionResult) => void;
}

/**
 * Inline provision form for the stack Data tab (lives inside a Collapsible —
 * never a modal). The generated API key is handed up to the section so it can
 * render the reveal-once banner above the instance list.
 */
export function VectorProvisionForm({
  stack,
  onProvisioned,
}: VectorProvisionFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<VectorDraft>({ ...EMPTY_VECTOR_DRAFT, stack });

  const provision = useMutation(
    trpc.vector.provision.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Qdrant ${r.name} is provisioning`);
        setDraft({ ...EMPTY_VECTOR_DRAFT, stack });
        onProvisioned(r);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Qdrant on your swarm — private by default, API key in a Docker secret, volume-backed
        storage, no published ports.
      </p>
      <CreateVectorFields draft={draft} onChange={setDraft} hideStack />
      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={() => provision.mutate({ stack, name: draft.name.trim() })}
          disabled={provision.isPending || !draft.name.trim()}
        >
          <BoxIcon className="size-4" />
          {provision.isPending ? 'Provisioning…' : `Provision in ${stack}`}
        </Button>
      </div>
    </div>
  );
}
