import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InboundEndpointView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { EndpointFields, type EndpointDraft } from './endpoint-fields';

function draftFromEndpoint(e: InboundEndpointView): EndpointDraft {
  return {
    name: e.name,
    slug: e.slug,
    slugTouched: true,
    domain: e.domain ?? '',
    verifyKind: e.verifyKind,
    secret: '',
    targetKind: e.target.kind,
    url: e.target.kind === 'forward' ? e.target.url : '',
    cacheCluster: e.target.kind === 'queue' ? e.target.cacheCluster : '',
    queue: e.target.kind === 'queue' ? e.target.queue : '',
    convention: e.target.kind === 'queue' ? e.target.convention : 'list',
    transformTemplate: e.transformTemplate ?? '',
    responseTemplate: e.responseTemplate ?? '',
    retentionDays: e.retentionDays,
  };
}

/** Edit an existing endpoint: verify/target/domain/templates (slug is locked). */
export function EndpointEditInline({
  endpoint,
  onDone,
}: {
  stack: string;
  endpoint: InboundEndpointView;
  onDone: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<EndpointDraft>(() => draftFromEndpoint(endpoint));

  const update = useMutation(
    trpc.inboundWebhooks.updateEndpoint.mutationOptions({
      onSuccess: () => {
        toast.success('Endpoint updated');
        void qc.invalidateQueries();
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = (): void => {
    update.mutate({
      id: endpoint.id,
      name: draft.name.trim(),
      domain: draft.domain.trim(),
      verifyKind: draft.verifyKind,
      ...(draft.verifyKind !== 'none' && draft.secret ? { secret: draft.secret } : {}),
      target:
        draft.targetKind === 'forward'
          ? { kind: 'forward', url: draft.url.trim() }
          : {
              kind: 'queue',
              cacheCluster: draft.cacheCluster,
              queue: draft.queue.trim(),
              convention: draft.convention,
            },
      transformTemplate: draft.transformTemplate,
      responseTemplate: draft.responseTemplate,
      retentionDays: draft.retentionDays,
    });
  };

  return (
    <div className="grid gap-4">
      <EndpointFields draft={draft} onChange={setDraft} editing />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
