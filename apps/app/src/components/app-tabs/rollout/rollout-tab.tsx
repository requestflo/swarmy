import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CodeView, Section, withHeader } from '@/components/calm';
import { CanaryStartCard } from '@/components/releases/canary-start-card';
import { SafetyCard } from '@/components/releases/safety-card';
import { HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { TabBody } from '../tab-body';
import { RolloutHeader } from './rollout-header';

/**
 * Config › Health & rollout (board AppRollout's settings half): how a change
 * goes out — the health watch and auto put-back, and trying a new version on
 * a slice of visitors first. A canary in flight shows on Releases.
 */
export function RolloutTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const safety = useQuery({ ...trpc.releases.getSafety.queryOptions({ stackName: stack }), refetchInterval: 15_000 });
  return (
    <TabBody
      asideAt="code"
      header={safety.data ? <RolloutHeader safety={safety.data} /> : <HeaderSkeleton />}
      aside={
        safety.data ? (
          <CodeView
            title="Rollout as code"
            source="readonly"
            tabs={[{ label: 'label', code: withHeader(`swarmy.deploy.safety on ${stack}, as swarmy reads it`, JSON.stringify(safety.data, null, 2)) }]}
          />
        ) : undefined
      }
    >
      <SafetyCard stackName={stack} />
      <Section title="Try it on a slice of visitors first" hint="canary">
        <p className="text-muted-foreground text-[13.5px]">
          A new version takes a share of visitors. It takes over when clean and goes away on errors.
        </p>
        <CanaryStartCard stack={stack} />
      </Section>
    </TabBody>
  );
}
