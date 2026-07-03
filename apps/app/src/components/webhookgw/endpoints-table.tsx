import * as React from 'react';
import type { InboundEndpointView } from '@swarmy/core';
import { EndpointRow } from './endpoint-row';

/** Flat endpoint rows in one card — each row-expands to edit inline. */
export function EndpointsTable({
  stack,
  endpoints,
}: {
  stack: string;
  endpoints: InboundEndpointView[];
}): React.JSX.Element {
  return (
    <div className="card-pop divide-border divide-y overflow-hidden">
      {endpoints.map((e) => (
        <EndpointRow key={e.id} stack={stack} endpoint={e} />
      ))}
    </div>
  );
}
