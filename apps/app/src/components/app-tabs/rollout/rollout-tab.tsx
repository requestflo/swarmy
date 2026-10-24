import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SpecHealthcheck } from '@swarmy/core';
import { CodeView } from '@/components/calm';
import { SafetyCard } from '@/components/releases/safety-card';
import { CardSkeleton, HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ServicePicker } from '../scaling/service-picker';
import { useScalingService } from '../scaling/use-scaling-service';
import { TabBody } from '../tab-body';
import { shortName, useStackServices } from '../use-stack-services';
import { CanarySection } from './canary-section';
import { DeployOrderSection } from './deploy-order-section';
import { HealthCheckSection } from './health-check-section';
import { ROLLOUT_NOTE, rolloutCode } from './rollout-code';
import { RolloutHeader } from './rollout-header';

/**
 * Config › Health & rollout (board AppRollout): one service at a time — how
 * swarmy knows it's healthy, how a new version replaces the old, trying one
 * on a slice of visitors (with the week's errors replayed against the
 * ceiling) — then the app's watch-and-put-back. A canary in flight is
 * watched on Releases.
 */
export function RolloutTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const safety = useQuery({ ...trpc.releases.getSafety.queryOptions({ stackName: stack }), refetchInterval: 15_000 });
  const { services } = useStackServices(stack);
  const rows = React.useMemo(() => services?.filter((s) => !s.name.endsWith('--canary')).map((inv) => ({ inv, detail: undefined })), [services]);
  const [pickedId, setPickedId] = React.useState<string | null>(null);
  const picked = rows?.find((r) => r.inv.id === pickedId)?.inv ?? rows?.[0]?.inv;
  const svc = useScalingService(picked);
  const name = picked ? shortName(stack, picked.name) : '';
  // The unsaved health-check edit at Controls, so the Code view shows what Save writes.
  const [draft, setDraft] = React.useState<{ id: string; hc: SpecHealthcheck | undefined } | null>(null);
  const pickedKey = picked?.id;
  const onDraft = React.useCallback((hc: SpecHealthcheck | undefined | null) => setDraft(hc === null || !pickedKey ? null : { id: pickedKey, hc }), [pickedKey]);
  const shownDraft = draft && draft.id === picked?.id ? draft : undefined;
  return (
    <TabBody
      asideAt="code"
      header={safety.data ? <RolloutHeader safety={safety.data} /> : <HeaderSkeleton />}
      aside={
        picked && svc.spec ? <CodeView title="Rollout as code" tabs={rolloutCode(stack, name, svc.spec, safety.data, shownDraft)} source="readonly" note={ROLLOUT_NOTE} /> : undefined
      }
    >
      {rows === undefined ? (
        <CardSkeleton lines={3} />
      ) : !picked ? (
        <p className="text-muted-foreground text-[13.5px]">{stack} has no services running yet, so there’s nothing to roll out.</p>
      ) : (
        <>
          <ServicePicker stack={stack} rows={rows} value={picked.id} onChange={setPickedId} />
          <HealthCheckSection key={`h-${picked.id}`} name={name} inv={picked} spec={svc.spec} onDraft={onDraft} />
          <DeployOrderSection key={`o-${picked.id}`} name={name} inv={picked} spec={svc.spec} />
          <CanarySection key={`c-${picked.id}`} stack={stack} inv={picked} name={name} address={svc.address} />
        </>
      )}
      <SafetyCard stackName={stack} />
    </TabBody>
  );
}
