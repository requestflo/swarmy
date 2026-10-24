import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InvService, SpecHealthcheck } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { cn } from '@swarmy/ui';
import { Section, TONE_DOT, TONE_TEXT, useDepth } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { HealthFacts } from './health-facts';
import { HealthForm } from './health-form';
import { healthWords } from './health-model';
import { HealthProbes } from './health-probes';
import { HealthTest } from './health-test';

/**
 * Health check (board AppRollout): how swarmy knows a copy is healthy.
 * Summary says the live check plainly; Controls makes the same facts
 * editable (Save = one rolling update). "Test now" runs it once in a
 * running copy; "Last N probes" is Docker's own record of the copies.
 */
export function HealthCheckSection({
  name,
  inv,
  spec,
  onDraft,
}: {
  name: string;
  inv: InvService;
  spec: ServiceSpec | null | undefined;
  onDraft: (hc: SpecHealthcheck | undefined | null) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const controls = useDepth().atLeast('controls');
  const probes = useQuery({ ...trpc.services.healthProbes.queryOptions({ id: inv.id }), refetchInterval: 10_000 });
  const [unsaved, setUnsaved] = React.useState(false);
  const draft = React.useCallback(
    (hc: SpecHealthcheck | undefined | null) => {
      setUnsaved(hc !== null);
      onDraft(hc);
    },
    [onDraft],
  );
  const live = spec?.healthcheck;
  const own = !!(live?.disable || live?.test?.length);
  const imageTest = probes.data?.test ?? null;
  const fromImage = !own && !!imageTest;
  const w = spec ? healthWords(fromImage && imageTest ? { test: imageTest } : live) : null;
  const { desired, running } = inv.replicas;
  const tone = desired > 0 && running >= desired ? 'ok' : running === 0 && desired > 0 ? 'bad' : desired === 0 ? 'idle' : 'warn';
  const chip = (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-[11.5px] font-semibold', TONE_TEXT[tone])}>
      <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {running} / {desired} {w?.kind === 'check' ? 'healthy' : 'running'}
    </span>
  );
  return (
    <Section title="Health check" hint={`how swarmy knows ${name} is healthy`} action={chip}>
      {spec === undefined ? (
        <CardSkeleton lines={2} />
      ) : spec === null || !w ? (
        <p className="text-muted-foreground text-[13.5px]">swarmy couldn’t read {name}’s settings just now, so its health check isn’t shown.</p>
      ) : (
        <>
          {controls ? (
            <HealthForm key={inv.id} name={name} inv={inv} spec={spec} imageTest={imageTest} onDraft={draft} />
          ) : (
            <HealthFacts name={name} w={w} fromImage={fromImage} />
          )}
          {w.kind === 'check' ? <HealthProbes name={name} data={probes.isError ? null : probes.data} /> : null}
          {w.kind === 'check' && running > 0 ? <HealthTest id={inv.id} name={name} unsaved={controls && unsaved} /> : null}
        </>
      )}
    </Section>
  );
}
