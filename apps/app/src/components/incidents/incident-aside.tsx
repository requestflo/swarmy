import * as React from 'react';
import type { IncidentDetailView } from '@swarmy/core';
import { CodeView } from '@/components/calm';
import { incidentCode } from './incident-code';

/** The incident as code (Code): read and resolve it over REST. Where it hit is the Blast radius card above. */
export function IncidentAside({ incident }: { incident: IncidentDetailView }): React.JSX.Element {
  return (
    <CodeView
      title="This incident as code"
      tabs={incidentCode(incident)}
      note="Read and resolve it over REST, with an org API key. Taking it and posting updates are dashboard actions."
    />
  );
}
