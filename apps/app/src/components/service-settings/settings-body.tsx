import * as React from 'react';
import { Depth } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { CommandRow, PortsRow } from './command-ports-rows';
import { CopiesRow, LabelsRow } from './copies-labels-rows';
import { ImageRow } from './image-row';
import { CrashRow, DeployRow } from './policy-rows';
import { ResourcesRow } from './resources-row';
import type { SettingsDraftState } from './use-settings-draft';
import type { ServiceSettingsData } from './use-service-settings';

/**
 * The settings sections, top to bottom (board ServiceSheet): copies, image,
 * command, ports, resources, if it crashes, during a deploy, labels. Summary
 * keeps the sentences and one-tap presets; Controls adds every tech line.
 */
export function SettingsBody({ data, d }: { data: ServiceSettingsData; d: SettingsDraftState }): React.JSX.Element {
  const s = data.service;
  if (!s) return <CardSkeleton lines={6} />;
  const spec = data.spec;
  const global = spec?.mode?.global !== undefined;
  return (
    <div className="flex flex-col">
      <CopiesRow
        running={s.replicas.running}
        desired={s.replicas.desired}
        want={d.draft.copies ?? s.replicas.desired}
        global={global}
        onChange={(n) => d.set({ copies: n })}
      />
      <ImageRow image={s.image} scan={data.scan} />
      {spec ? <CommandRow spec={spec} /> : null}
      <PortsRow ports={s.ports} hosts={data.hosts} stack={s.stackId} />
      {spec === undefined ? (
        <CardSkeleton lines={4} />
      ) : spec === null ? (
        <p className="text-muted-foreground border-border border-t py-3.5 text-[13.5px]">
          swarmy couldn&apos;t read this part&apos;s live settings just now, so there&apos;s nothing to change here yet.
        </p>
      ) : (
        <>
          <ResourcesRow spec={spec} usage={data.usage} draft={d.draft} set={d.set} />
          <CrashRow spec={spec} draft={d.draft} set={d.set} />
          <DeployRow spec={spec} draft={d.draft} set={d.set} stack={s.stackId} />
          <Depth at="controls">
            <LabelsRow labels={spec.labels ?? {}} />
          </Depth>
        </>
      )}
    </div>
  );
}
