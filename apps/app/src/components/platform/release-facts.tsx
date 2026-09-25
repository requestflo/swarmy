import * as React from 'react';
import { RowList, Section } from '@/components/calm';
import { LineRow as CalmRow } from '@/components/rowpage/line-row';
import { when, type PlatformStatus } from './use-platform';

/** The release set-up in one glance: channel, patch window, last check. Change them from Controls. */
export function ReleaseFacts({ v }: { v: PlatformStatus }): React.JSX.Element {
  const p = v.release.policy;
  return (
    <Section title="How swarmy updates" flush>
      <RowList label="Release settings">
        <CalmRow tone="info" name="Channel" say={p.channel === 'edge' ? 'Edge: every main build, new first' : 'Stable: tagged releases'} tech={p.feed} />
        <CalmRow tone={p.autoApplyPatches ? 'ok' : 'idle'} name="Security patches" say={p.autoApplyPatches ? `Applied by themselves, ${p.windowText}` : `You press the button; window ${p.windowText}`} word={p.autoApplyPatches ? 'Auto' : 'Manual'} />
        <CalmRow tone={v.release.lastCheckError ? 'warn' : 'ok'} name="Last checked" say={v.release.lastCheckError ? `Failed: ${v.release.lastCheckError}` : when(v.release.lastCheckAt)} tech={`controller ${v.release.controller.version} · ${v.release.controller.commit.slice(0, 7)}`} />
      </RowList>
    </Section>
  );
}
