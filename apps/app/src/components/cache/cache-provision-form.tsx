import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ZapIcon } from 'lucide-react';
import type { CacheProvisionResult } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { parseRegionPlans } from './cache-region-field';
import { CreateCacheFields, EMPTY_DRAFT, type CacheDraft } from './create-cache-fields';

interface CacheProvisionFormProps {
  /** The workspace stack — provisioning always lands here. */
  stack: string;
  /** Fired with the reveal-once credentials; the section shows the banner. */
  onProvisioned: (result: CacheProvisionResult) => void;
}

/**
 * Inline provision form for the stack Data tab (lives inside a Collapsible —
 * never a modal). The generated password is handed up to the section so it can
 * render the reveal-once banner above the cluster list.
 */
export function CacheProvisionForm({
  stack,
  onProvisioned,
}: CacheProvisionFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<CacheDraft>({ ...EMPTY_DRAFT, stack });

  const provision = useMutation(
    trpc.cache.provision.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Cache ${r.cluster} is provisioning`);
        setDraft({ ...EMPTY_DRAFT, stack });
        onProvisioned(r);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    provision.mutate({
      stack,
      name: draft.name.trim(),
      engine: draft.engine,
      topology: draft.topology,
      memoryMb: draft.memoryMb,
      replicas: draft.topology === 'single' ? 0 : draft.replicas,
      regions: parseRegionPlans(draft.regions),
      ...(draft.attachService ? { attachService: draft.attachService } : {}),
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Valkey or Redis on your own swarm — private by default, password in a Docker secret, no
        published ports.
      </p>
      <CreateCacheFields draft={draft} onChange={setDraft} hideStack />
      <div className="flex justify-end">
        <Button variant="outline" onClick={submit} disabled={provision.isPending || !draft.name.trim()}>
          <ZapIcon className="size-4" />
          {provision.isPending ? 'Provisioning…' : `Provision in ${stack}`}
        </Button>
      </div>
    </div>
  );
}
