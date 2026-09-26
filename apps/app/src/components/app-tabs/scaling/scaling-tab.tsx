import * as React from 'react';
import { CodeView, Depth } from '@/components/calm';
import { StackSettingsTab } from '@/components/ai/stack-settings/stack-settings-tab';
import { HeaderSkeleton } from '@/components/states';
import { RowsSkeleton, TabBody } from '../tab-body';
import { CopiesSection } from './copies-section';
import { scalingCode } from './scaling-model';
import { ScalingNext } from './scaling-next';
import { SettingsHeader } from './settings-header';
import { useAppPlacement } from './use-app-placement';

/**
 * Config › Scaling (board AppScaling): copies per part at Summary; the
 * steppers and the app's own settings (environment, AI gateway, add a
 * service, remove the app) from Controls; the live deploy block at Code.
 * Where each part runs is Config › Placement & volumes.
 */
export function ScalingTab({ stack }: { stack: string }): React.JSX.Element {
  const { rows, nodes } = useAppPlacement(stack);
  const ready = rows && nodes;
  return (
    <TabBody
      asideAt="code"
      header={ready ? <SettingsHeader stack={stack} rows={rows} nodes={nodes} /> : <HeaderSkeleton />}
      aside={ready ? <CodeView title="Scaling as code" tabs={scalingCode(stack, rows)} source="readonly" /> : undefined}
    >
      {ready ? <ScalingNext stack={stack} rows={rows} /> : null}
      {ready ? <CopiesSection stack={stack} rows={rows} nodes={nodes} /> : <RowsSkeleton />}
      <Depth at="controls">
        <section aria-label="App settings" className="flex flex-col gap-3">
          <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">App settings</h2>
          <StackSettingsTab stack={stack} />
        </section>
      </Depth>
    </TabBody>
  );
}
