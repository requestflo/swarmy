import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalmRow, RowList, Section } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { copyLagLine } from './copy-lag-words';
import type { TargetRow } from './destinations-card';
import { NATIVE_TARGET_NAME } from './native-target-name';

/**
 * Where backups go, one row each: on your own servers or off-site. A
 * destination that schedules also copy to says how far that copy trails
 * (`backups.copyLag`).
 */
export function DestinationRows({ targets }: { targets: TargetRow[] }): React.JSX.Element {
  const trpc = useTRPC();
  const lag = useQuery({ ...trpc.backups.copyLag.queryOptions(), refetchInterval: 60_000 });
  return (
    <Section title="Where backups go" count={targets.length} flush>
      {targets.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">Nowhere yet. Give backups a home first.</p>
      ) : (
        <RowList label="Backup destinations">
          {targets.map((t) => {
            const native = t.name === NATIVE_TARGET_NAME;
            const offsite = t.kind.toLowerCase() === 's3' && !native;
            const where = `${t.kind.toLowerCase()} · ${t.endpoint ? `${t.endpoint}/` : ''}${t.bucket}${t.prefix ? `/${t.prefix}` : ''}`;
            const copy = (lag.data ?? []).find((l) => l.targetId === t.id);
            const line = copy ? copyLagLine(copy) : null;
            return (
              <CalmRow
                key={t.id}
                tone={!t.enabled ? 'idle' : line && line.tone !== 'idle' ? line.tone : 'ok'}
                name={native ? 'Your own servers' : t.name}
                sub={native ? 'swarmy object storage' : t.kind.toLowerCase() === 's3' ? 'S3 bucket' : 'a folder on a server'}
                say={line ? line.say.replace(/^Second copy/, offsite ? 'Off-site copy' : 'Second copy') : offsite ? 'Off-site copy, outside your servers' : native ? 'Kept on several servers, encrypted' : 'On one server, encrypted'}
                tech={line ? `${where} · ${line.tech}` : where}
                word={t.enabled ? 'Online' : 'Idle'}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
