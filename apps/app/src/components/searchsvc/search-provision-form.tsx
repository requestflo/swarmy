import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import type { SearchProvisionResult } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CreateSearchFields, EMPTY_SEARCH_DRAFT, type SearchDraft } from './create-search-fields';

interface SearchProvisionFormProps {
  /** The workspace stack — provisioning always lands here. */
  stack: string;
  /** Fired with the reveal-once master key; the section shows the banner. */
  onProvisioned: (result: SearchProvisionResult) => void;
}

/**
 * Inline provision form for the stack Data tab (lives inside a Collapsible —
 * never a modal). The generated master key is handed up to the section so it
 * can render the reveal-once banner above the instance list.
 */
export function SearchProvisionForm({
  stack,
  onProvisioned,
}: SearchProvisionFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<SearchDraft>({ ...EMPTY_SEARCH_DRAFT, stack });

  const provision = useMutation(
    trpc.search.provision.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Search instance ${r.name} is provisioning`);
        setDraft({ ...EMPTY_SEARCH_DRAFT, stack });
        onProvisioned(r);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Meilisearch or Typesense on your own swarm — private by default, master key in a Docker
        secret, no published ports.
      </p>
      <CreateSearchFields draft={draft} onChange={setDraft} hideStack />
      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={() =>
            provision.mutate({
              stack,
              name: draft.name.trim(),
              engine: draft.engine,
              ...(draft.attachService ? { attachService: draft.attachService } : {}),
            })
          }
          disabled={provision.isPending || !draft.name.trim()}
        >
          <SearchIcon className="size-4" />
          {provision.isPending ? 'Provisioning…' : `Provision in ${stack}`}
        </Button>
      </div>
    </div>
  );
}
