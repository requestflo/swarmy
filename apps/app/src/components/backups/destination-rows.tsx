import * as React from 'react';
import { CalmRow, RowList, Section } from '@/components/calm';
import type { TargetRow } from './destinations-card';
import { NATIVE_TARGET_NAME } from './native-target-name';

/** Where backups go, one row each: on your own servers or off-site. */
export function DestinationRows({ targets }: { targets: TargetRow[] }): React.JSX.Element {
  return (
    <Section title="Where backups go" count={targets.length} flush>
      {targets.length === 0 ? (
        <p className="text-muted-foreground pb-3 text-[13px]">Nowhere yet. Give backups a home first.</p>
      ) : (
        <RowList label="Backup destinations">
          {targets.map((t) => {
            const native = t.name === NATIVE_TARGET_NAME;
            const offsite = t.kind.toLowerCase() === 's3' && !native;
            return (
              <CalmRow
                key={t.id}
                tone={t.enabled ? 'ok' : 'idle'}
                name={native ? 'Your own servers' : t.name}
                sub={native ? 'swarmy object storage' : t.kind.toLowerCase() === 's3' ? 'S3 bucket' : 'a folder on a server'}
                say={offsite ? 'Off-site copy, outside your servers' : native ? 'Kept on several servers, encrypted' : 'On one server, encrypted'}
                tech={`${t.kind.toLowerCase()} · ${t.endpoint ? `${t.endpoint}/` : ''}${t.bucket}${t.prefix ? `/${t.prefix}` : ''}`}
                word={t.enabled ? 'Online' : 'Idle'}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
