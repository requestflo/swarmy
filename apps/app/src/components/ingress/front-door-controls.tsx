import * as React from 'react';
import { ControllerImageCard } from './controller-image-card';
import { WildcardCertsCard } from './wildcard-certs-card';
import type { useFrontDoor } from './use-front-door';

/**
 * The Front door's remaining Controls-depth knobs for swarmy's Caddy. The
 * topology, the edge switches and on-demand certificates are board 31's
 * sections; the tunnel shows wherever it is in use or asked for.
 */
export function FrontDoorControls({ f }: { f: ReturnType<typeof useFrontDoor> }): React.JSX.Element | null {
  const c = f.config.data;
  if (!c || f.driver !== 'caddy') return null;
  return (
    <>
      <WildcardCertsCard />
      <ControllerImageCard image={c.controllerImage ?? null} defaultImage={c.defaultControllerImage ?? null} />
    </>
  );
}
