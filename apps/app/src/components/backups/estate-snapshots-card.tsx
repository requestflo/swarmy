import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Section, useDepth } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { SnapshotRows } from './snapshot-rows';

/** Estate-wide restore points, newest first (the latest few at Summary, all from Controls). Live (5s poll). */
export function EstateSnapshotsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const { atLeast } = useDepth();
  const snapshots = useQuery({ ...trpc.backups.listSnapshots.queryOptions({}), refetchInterval: 5_000 });
  const rows = snapshots.data ?? [];
  const shown = atLeast('controls') ? rows : rows.slice(0, 8);
  return (
    <Section title="Restore points" count={`${rows.length} kept`} hint={shown.length < rows.length ? `latest ${shown.length}` : undefined} flush>
      <SnapshotRows
        rows={shown}
        emptyTitle="No restore points yet"
        emptyDescription="Every app volume is saved nightly. The first ones land here after tonight's run, or back one up now from its app's Backups tab."
      />
    </Section>
  );
}
