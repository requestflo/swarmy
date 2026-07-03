import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigFamilyView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StackServiceSelect } from '@/components/secretsmgr/stack-service-select';

interface AttachConfigInlineProps {
  family: ConfigFamilyView;
  stack: string;
  open: boolean;
  onDone: () => void;
}

/**
 * Inline attach (expands under the row, no modal): mount the current version
 * into one of THIS stack's services at the family's stable path. One restart.
 */
export function AttachConfigInline({
  family,
  stack,
  open,
  onDone,
}: AttachConfigInlineProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [service, setService] = React.useState('');

  const attach = useMutation(
    trpc.configs.attach.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.family} mounted into ${r.service} at ${r.mountPath}`);
        setService('');
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={open}>
      <CollapsibleContent>
        <div className="border-border bg-card space-y-3 rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">
            The service restarts once and reads the file from{' '}
            <code className="mono-data">{family.mountPath}</code> — applying new versions swaps the
            content without touching the path.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <StackServiceSelect
              stack={stack}
              value={service}
              onChange={setService}
              exclude={family.consumers.map((c) => c.serviceName)}
              emptyHint="Every service in this stack already has this config (or none are deployed)."
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              disabled={!service || attach.isPending}
              onClick={() => attach.mutate({ family: family.family, service })}
            >
              {attach.isPending ? 'Attaching…' : 'Attach & restart'}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
