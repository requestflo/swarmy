import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, RowList, Section } from '@/components/calm';
import { LineRow } from '@/components/rowpage/line-row';
import { CardSkeleton } from '@/components/states';
import { relTime } from '@/lib/format';
import { appsLabel, expiresSoon, presetLabel, untilWords } from './key-words';
import { SayParts } from './say-parts';

const WORD = { active: 'Active', expired: 'Expired', revoked: 'Revoked' } as const;

/** Every org API key: name · key · can · apps · last used · expires; revoke from Controls. */
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
            <p className="text-muted-foreground py-4 text-sm">None yet. A key lets curl, the SDKs, Terraform or CI reach swarmy as you. Make one with New key.</p>
          ) : (
            rows.map((k) => {
              const soon = expiresSoon(k);
              const ends = k.status !== 'active' ? k.status : k.expiresAt ? `expires ${untilWords(k.expiresAt)}` : 'never expires';
              return (
              <LineRow
                key={k.id}
                tone={k.status !== 'active' ? 'idle' : soon ? 'warn' : 'ok'}
                name={k.name}
                sub={`swk_${k.prefix}…`}
                say={<SayParts parts={[`${presetLabel(k)} on ${appsLabel(k.stackNames)}`, `used ${k.lastUsedAt ? relTime(k.lastUsedAt) : 'never'}`, ends]} />}
                tech={`scopes ${k.scopes.join(',')}${k.stackNames ? ` · stack_names ${k.stackNames.join(',')}` : ''} · expires_at ${k.expiresAt ? k.expiresAt.slice(0, 10) : 'null'} · made ${relTime(k.createdAt)}`}
                word={soon ? 'Expiring' : WORD[k.status]}
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
            );
          })
        )}
      </RowList>
    </Section>
  );
}
