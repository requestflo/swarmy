import * as React from 'react';
import { Section } from '@/components/calm';
import { UpgradeComponents } from './upgrade-components';
import { UpgradeTimeline } from './upgrade-timeline';
import { STEP_TEXT, when, type PlatformStatus } from './use-platform';

/** How an upgrade goes: the steps (live when a run is on), its log, and the images that change. */
export function ReleaseSteps({ v }: { v: PlatformStatus }): React.JSX.Element {
  const { run, release } = v;
  const av = release.available;
  const recent = run && (run.status === 'running' || run.status === 'failed' || (run.finishedAt && Date.now() - new Date(run.finishedAt).getTime() < 24 * 3600_000));
  const pause = av?.migrations.some((m) => m.pause) ?? false;
  return (
    <Section
      title={recent ? `Run ${run.fromVersion} → ${run.toVersion}` : 'How an upgrade goes'}
      hint={recent ? `started ${when(run.startedAt)}` : 'each piece health-checked, put back on its own if it fails'}
    >
      <UpgradeTimeline steps={recent ? run.steps : Object.keys(STEP_TEXT).map((key) => ({ key, status: 'pending', detail: null, error: null }))} pauses={pause} />
      {recent && run.log.length ? (
        <ol className="calm-code text-muted-foreground max-h-48 space-y-0.5 overflow-y-auto px-3 py-2 text-xs">
          {run.log.slice(-20).map((l) => (
            <li key={l.at + l.msg}>{new Date(l.at).toLocaleTimeString()} {l.msg}</li>
          ))}
        </ol>
      ) : null}
      {av ? <UpgradeComponents av={av} fromVersion={release.current.version} /> : null}
    </Section>
  );
}
