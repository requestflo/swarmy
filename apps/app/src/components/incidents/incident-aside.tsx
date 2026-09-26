import * as React from 'react';
import type { IncidentDetailView } from '@swarmy/core';
import { CodeView } from '@/components/calm';

/** The incident as data (Code). Where it hit is the Blast radius card above. */
export function IncidentAside({ incident }: { incident: IncidentDetailView }): React.JSX.Element {
  return <CodeView title="This incident as data" tabs={[{ label: 'JSON', code: JSON.stringify(incident, null, 2) }]} source="readonly" />;
}
