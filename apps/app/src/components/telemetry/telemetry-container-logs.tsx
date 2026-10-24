import * as React from 'react';
import { containerLogsOn, type TelemetrySettings } from '@swarmy/core';
import { Section, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';

/**
 * Container output: read what every app prints, so apps that never send
 * telemetry still have logs. Saved with the rest of the settings (Apply).
 */
export function TelemetryContainerLogs({
  s,
  change,
}: {
  s: TelemetrySettings;
  change: (fn: (s: TelemetrySettings) => TelemetrySettings) => void;
}): React.JSX.Element {
  const on = containerLogsOn(s);
  return (
    <Section title="What apps print" hint="for apps that don’t send logs">
      <div className="border-border bg-background/60 flex min-w-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold">
          <QuietSwitch
            checked={on}
            onCheckedChange={(v) => change((c) => ({ ...c, containerLogs: { enabled: v } }))}
            aria-label="Keep what every app prints"
          />
          Keep what every app prints
        </span>
        <span className="text-muted-foreground text-[12.5px]">
          {on
            ? `Each server reads its apps’ output and keeps it ${s.retention.logsDays} days, like the other logs. An app that also sends its logs shows each line once. Apps deployed before this was on join on their next deploy.`
            : 'Off — only apps that send telemetry have logs.'}
        </span>
      </div>
      <Tech>
        filelog · one agent per server · /var/lib/docker/containers read-only · json-file labels=swarmy.stack,swarmy.service · opt a part out with swarmy.logs.stdout=off
      </Tech>
    </Section>
  );
}
