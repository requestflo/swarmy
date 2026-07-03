import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EMPTY_ENDPOINT_DRAFT, EndpointFields, type EndpointDraft } from './endpoint-fields';

/**
 * Inline create form for an inbound endpoint: name + slug, custom domain,
 * verification, target and the transform/response templates. Replaces the
 * old create-endpoint dialog — a Collapsible parent supplies expand/collapse.
 */
export function CreateEndpointInline({
  stack,
  onDone,
}: {
  stack: string;
  onDone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<EndpointDraft>(EMPTY_ENDPOINT_DRAFT);

  const create = useMutation(
    trpc.inboundWebhooks.createEndpoint.mutationOptions({
      onSuccess: (e) => {
        toast.success(`Endpoint live — paste ${e.url} into the provider`);
        setDraft(EMPTY_ENDPOINT_DRAFT);
        void qc.invalidateQueries();
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const targetReady =
    draft.targetKind === 'forward'
      ? /^https?:\/\/.+/.test(draft.url)
      : Boolean(draft.cacheCluster && draft.queue.trim());
  const ready = Boolean(
    draft.name.trim() &&
      draft.slug &&
      targetReady &&
      (draft.verifyKind === 'none' || draft.secret.length >= 8),
  );

  const submit = (): void => {
    create.mutate({
      name: draft.name.trim(),
      slug: draft.slug,
      stackName: stack,
      ...(draft.domain.trim() ? { domain: draft.domain.trim() } : {}),
      verifyKind: draft.verifyKind,
      ...(draft.verifyKind !== 'none' ? { secret: draft.secret } : {}),
      target:
        draft.targetKind === 'forward'
          ? { kind: 'forward', url: draft.url.trim() }
          : {
              kind: 'queue',
              cacheCluster: draft.cacheCluster,
              queue: draft.queue.trim(),
              convention: draft.convention,
            },
      ...(draft.transformTemplate.trim() ? { transformTemplate: draft.transformTemplate } : {}),
      ...(draft.responseTemplate.trim() ? { responseTemplate: draft.responseTemplate } : {}),
      retentionDays: draft.retentionDays,
    });
  };

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-xs">
        You get a public URL to paste into the provider. swarmy verifies every payload, keeps the
        history, and delivers it to your queue or service — retrying on failure.
      </p>
      <EndpointFields draft={draft} onChange={setDraft} />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={!ready || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create endpoint'}
        </Button>
      </div>
    </div>
  );
}
