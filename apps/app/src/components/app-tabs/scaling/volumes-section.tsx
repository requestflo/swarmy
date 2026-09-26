import * as React from 'react';
import { CalmRow, Section } from '@/components/calm';
import { shortName } from '../use-stack-services';
import type { PlacedService } from './use-app-placement';

/** The data each part keeps on disk, from the live spec (read-only). Saving it is the Backups tab. */
export function VolumesSection({ stack, rows }: { stack: string; rows: PlacedService[] }): React.JSX.Element {
  const mounts = rows.flatMap(({ inv, detail }) =>
    (detail?.volumes ?? []).map((v) => ({ part: shortName(stack, inv.name), ...v })),
  );
  return (
    <Section title="Volumes" count={mounts.length} hint="what each part keeps on disk" flush>
      {mounts.length === 0 ? (
        <p className="text-muted-foreground px-1 py-3 text-[13.5px]">
          Nothing here keeps files on disk. Every copy starts clean, so any server can run it.
        </p>
      ) : (
        <div className="flex flex-col">
          {mounts.map((m) => (
            <CalmRow
              key={`${m.part}:${m.target}`}
              tone="ok"
              name={m.part}
              sub={m.target}
              say={m.type === 'volume' ? `Keeps ${m.source ?? 'its data'} on the server it runs on` : `Reads ${m.source ?? m.target} from the server`}
              tech={`${m.type} · ${m.source ?? '—'}:${m.target}${m.readOnly ? ':ro' : ''}`}
              word={m.readOnly ? 'Read-only' : 'Kept'}
              wordTone="idle"
            />
          ))}
        </div>
      )}
    </Section>
  );
}
