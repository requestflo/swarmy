import * as React from 'react';
import { Section } from '@/components/calm';
import { InfraCanvas } from '@/components/infrastructure/infra-canvas';
import { InfraGlobeFallback, InfraViewToggle, type InfraView } from '@/components/infrastructure/infra-view-toggle';

const RegionGlobe = React.lazy(
  () => import('@/components/infrastructure/region-globe') as Promise<{ default: React.ComponentType }>,
);

/** The fleet on a canvas or a globe — spatial context at Controls, never the way in. */
export function ServersMap(): React.JSX.Element {
  const [view, setView] = React.useState<InfraView>('canvas');
  return (
    <Section title="Map" hint="where each server sits" action={<InfraViewToggle view={view} onChange={setView} />}>
      {view === 'canvas' ? (
        <InfraCanvas />
      ) : (
        <React.Suspense fallback={<InfraGlobeFallback />}>
          <RegionGlobe />
        </React.Suspense>
      )}
    </Section>
  );
}
