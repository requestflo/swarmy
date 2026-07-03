import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { EyeIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent, CopyButton, toast } from '@swarmy/ui';
import type { ServiceModelOut } from '@swarmy/core/compose';
import { useTRPC, useTRPCClient } from '@/integrations/trpc';

interface PreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ServiceModelOut;
}

/**
 * "View as compose / docker service create" — the unopinionated escape hatch.
 *
 * Docked inline panel (never a modal): compose.yaml and the ServiceSpec JSON
 * render side-by-side once there's room (`xl`), stacked below that. The name
 * is kept for the existing call site, which still toggles it from the page
 * header's "Preview" button.
 */
export function PreviewDialog({ open, onOpenChange, model }: PreviewDialogProps): React.JSX.Element {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const [compose, setCompose] = React.useState('');
  const [spec, setSpec] = React.useState('');

  const exportCompose = useMutation(
    trpc.builder.exportCompose.mutationOptions({
      onSuccess: (res) => setCompose(res.yaml),
      onError: (e) => toast.error(e.message),
    }),
  );

  React.useEffect(() => {
    if (!open) return;
    exportCompose.mutate({ models: [model] });
    client.builder.exportServiceSpec
      .query({ model })
      .then((res) => setSpec(res?.spec ? JSON.stringify(res.spec, null, 2) : ''))
      .catch((e: Error) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mb-4">
      <CollapsibleContent>
        <section className="card-pop grid gap-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
                <EyeIcon className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold">Preview</p>
                <p className="text-muted-foreground text-xs">
                  The exact artifact swarmy would apply — runs on vanilla Docker Swarm.
                </p>
              </div>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <PreviewPane label="compose.yaml" content={compose} />
            <PreviewPane label="ServiceSpec (JSON)" content={spec} />
          </div>
        </section>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PreviewPane({ label, content }: { label: string; content: string }): React.JSX.Element {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="mono-label">{label}</span>
        <CopyButton value={content} />
      </div>
      <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 font-mono text-xs">
        {content || '…'}
      </pre>
    </div>
  );
}
