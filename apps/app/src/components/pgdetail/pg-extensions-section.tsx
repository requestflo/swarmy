import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Switch, toast } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import type { PgDetailData } from './use-pg-detail';

/**
 * Extensions (board 39): pgvector, enabled in place on the main copy
 * (`vector.enablePgvector` → `CREATE EXTENSION IF NOT EXISTS vector`) and
 * copied to every standby. Apps keep their DATABASE_URL. Enable-only: dropping
 * the extension would drop every vector column, so there is no off switch.
 */
export function PgExtensionsSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const c = d.cluster!;
  const enable = useMutation(
    trpc.vector.enablePgvector.mutationOptions({
      onSuccess: () => {
        toast.success(`pgvector is on in ${c.name} — apps can query embeddings over their DATABASE_URL`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const on = d.pgvector?.enabled ?? false;
  const running = c.primary.status === 'running';
  return (
    <Section title="Extensions" hint="run on the main copy, copied to every standby">
      <div className="flex items-center gap-3">
        <span className="w-24 shrink-0 font-mono text-[13px] font-semibold">vector</span>
        <span className="text-muted-foreground min-w-0 flex-1 text-[13px] leading-snug">
          {on
            ? 'On. Apps keep their DATABASE_URL and can store and search embeddings now.'
            : 'Store and search embeddings in this database. Turned on in place; apps keep their DATABASE_URL.'}
        </span>
        <Switch
          checked={on}
          disabled={on || !running || enable.isPending || !d.pgvector}
          onCheckedChange={(v) => (v ? enable.mutate({ stack, cluster: c.name }) : undefined)}
          aria-label="pgvector"
        />
      </div>
      <Tech>
        {on
          ? 'swarmy.vector.pgvector=true · there is no off switch: DROP EXTENSION would drop every vector column'
          : `CREATE EXTENSION IF NOT EXISTS vector on ${c.primary.service}${running ? '' : ' · needs the main copy running'}`}
      </Tech>
    </Section>
  );
}
