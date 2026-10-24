import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { PgExtensionRow } from './pg-extension-row';
import { postgisWords, statementsWords } from './pg-extension-words';
import type { PgDetailData } from './use-pg-detail';
import { usePgExtensions } from './use-pg-extensions';

/**
 * Extensions (board 39), run on the main copy and copied to every standby.
 *   vector: enabled in place (`vector.enablePgvector`); enable-only, since
 *     dropping it would drop every vector column.
 *   pg_stat_statements: `db.setExtension`. It must be in
 *     shared_preload_libraries, so the reconcile restarts each copy, the
 *     standbys first and then the main copy in place, and the row says so.
 *   postgis: offered only when the image ships it (pgvector/pgvector:pg17
 *     doesn't); enable-only, like vector.
 */
export function PgExtensionsSection({ stack, d }: { stack: string; d: PgDetailData }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const c = d.cluster!;
  const ext = usePgExtensions(stack, c.name);
  const enable = useMutation(
    trpc.vector.enablePgvector.mutationOptions({
      onSuccess: () => {
        toast.success(`pgvector is on in ${c.name}. Apps can query embeddings over their DATABASE_URL`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const on = d.pgvector?.enabled ?? false;
  const running = c.primary.status === 'running';
  const v = ext.view;
  const stats = v?.extensions.find((x) => x.name === 'pg_stat_statements');
  const gis = v?.extensions.find((x) => x.name === 'postgis');
  return (
    <Section title="Extensions" hint="run on the main copy, copied to every standby">
      <div className="flex flex-col gap-4">
        <PgExtensionRow
          name="vector"
          sentence={on ? 'On. Apps keep their DATABASE_URL and can store and search embeddings now.' : 'Store and search embeddings in this database. Turned on in place; apps keep their DATABASE_URL.'}
          tech={on ? 'swarmy.vector.pgvector=true · there is no off switch: DROP EXTENSION would drop every vector column' : `CREATE EXTENSION IF NOT EXISTS vector on ${c.primary.service}${running ? '' : ' · needs the main copy running'}`}
          checked={on}
          disabled={on || !running || enable.isPending || !d.pgvector}
          onChange={(x) => (x ? enable.mutate({ stack, cluster: c.name }) : undefined)}
        />
        {!v || !stats || !gis ? (
          ext.pending ? <CardSkeleton /> : <p className="text-muted-foreground text-[13px]">Couldn’t read the other extensions: {ext.error?.message ?? 'unknown error'}.</p>
        ) : (
          <>
            <ExtRow x={stats} words={statementsWords(stats, v)} saving={ext.saving} onChange={(x) => ext.toggle('pg_stat_statements', x)} />
            <ExtRow x={gis} words={postgisWords(gis, v)} saving={ext.saving} onChange={(x) => ext.toggle('postgis', x)} />
          </>
        )}
      </div>
    </Section>
  );
}

function ExtRow({ x, words, saving, onChange }: {
  x: { name: string; wanted: boolean };
  words: ReturnType<typeof statementsWords>;
  saving: boolean;
  onChange: (on: boolean) => void;
}): React.JSX.Element {
  return (
    <PgExtensionRow
      name={x.name}
      sentence={words.sentence}
      tech={words.tech}
      checked={x.wanted}
      busy={words.busy}
      disabled={!words.canToggle || saving}
      onChange={onChange}
    />
  );
}
