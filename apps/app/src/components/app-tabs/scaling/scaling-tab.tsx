import * as React from 'react';
import { CodeView, Depth } from '@/components/calm';
import { StackSettingsTab } from '@/components/ai/stack-settings/stack-settings-tab';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { TabBody } from '../tab-body';
import { shortName } from '../use-stack-services';
import { DriftBanner } from './drift-banner';
import { scalingPageCode, scalingSourceNote } from './scaling-code';
import { ScalingNext } from './scaling-next';
import { ServicePicker } from './service-picker';
import { ServiceScaling } from './service-scaling';
import { SettingsHeader } from './settings-header';
import { useAppDrift } from './use-app-drift';
import { useScalingPage } from './use-scaling-page';

/**
 * Config › Scaling (board AppScaling): the app's copies in a sentence, the
 * drift banner when it deploys from git, then one service at a time — where
 * its copies run, copies, size of each copy, sleep when idle and yesterday
 * replayed. Knobs from Controls; the app's own settings below them; the
 * picked service as swarmy.yaml / compose / REST at Code.
 */
export function ScalingTab({ stack }: { stack: string }): React.JSX.Element {
  const page = useScalingPage(stack);
  const drift = useAppDrift(stack);
  const { rows, nodes, picked, svc, draft } = page;
  const ready = rows && nodes;
  const git = drift.git ? { configPath: drift.git.app.configPath, branch: drift.git.env.branch, enforceDrift: drift.git.app.enforceDrift } : null;
  const s2z = picked?.detail?.scaleToZero;
  const code =
    picked && svc.spec !== undefined
      ? scalingPageCode(
          stack,
          {
            inv: picked.inv,
            name: shortName(stack, picked.inv.name),
            limits: svc.spec?.resources?.limits,
            sleepSec: (s2z?.enabled ?? picked.inv.scaleToZero) ? (s2z?.idleSeconds ?? null) : null,
          },
          git,
        )
      : undefined;
  return (
    <TabBody
      asideAt="code"
      header={ready ? <SettingsHeader stack={stack} rows={rows} nodes={nodes} /> : <HeaderSkeleton />}
      aside={code ? <CodeView title="Scaling as code" tabs={code} source={git ? 'yaml' : 'dashboard'} note={scalingSourceNote(git)} /> : undefined}
    >
      {/* While a size change waits for Apply, Apply is the page's one action. */}
      {ready && draft.changes.length === 0 ? <ScalingNext stack={stack} rows={rows} /> : null}
      <DriftBanner stack={stack} drift={drift} />
      {ready ? (
        <>
          <ServicePicker stack={stack} rows={rows} value={picked?.inv.id} onChange={page.pick} />
          <ServiceScaling stack={stack} page={page} />
        </>
      ) : (
        <CardSkeleton lines={3} />
      )}
      <Depth at="controls">
        <section aria-label="App settings" className="flex flex-col gap-3">
          <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">App settings</h2>
          <StackSettingsTab stack={stack} />
        </section>
      </Depth>
    </TabBody>
  );
}
