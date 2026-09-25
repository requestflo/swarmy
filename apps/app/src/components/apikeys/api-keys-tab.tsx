import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, RowList, Section } from '@/components/calm';
import { LineRow } from '@/components/rowpage/line-row';
import { CardSkeleton } from '@/components/states';
import { relTime } from '@/lib/format';

/** Every org API key: what it may do, when it was last used; revoke from Controls. */
export function ApiKeysTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const keys = useQuery(trpc.apiKeys.list.queryOptions());
  const revoke = useMutation(
    trpc.apiKeys.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Key revoked');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (keys.isLoading) return <CardSkeleton lines={3} />;
  const rows = keys.data ?? [];
  const active = rows.filter((k) => k.status === 'active').length;
  return (
    <Section id="keys" title="API keys" count={`${active} active`} flush>
      <RowList label="API keys">
        {rows.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">None yet. A key lets curl, the SDKs, Terraform or CI reach swarmy as you.</p>
        ) : (
          rows.map((k) => (
            <LineRow
              key={k.id}
              tone={k.status === 'active' ? 'ok' : 'idle'}
              name={k.name}
              sub={`swk_${k.prefix}…`}
              say={`${k.scopes.includes('write') ? 'Reads and changes things' : 'Reads only'} · last used ${k.lastUsedAt ? relTime(k.lastUsedAt) : 'never'}`}
              tech={`scopes ${k.scopes.join(',')} · made ${relTime(k.createdAt)}`}
              word={k.status === 'active' ? 'Active' : 'Revoked'}
              trailing={
                k.status === 'active' ? (
                  <Depth at="controls">
                    <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: k.id })}>
                      Revoke
                    </Button>
                  </Depth>
                ) : null
              }
            />
          ))
        )}
      </RowList>
    </Section>
  );
}
