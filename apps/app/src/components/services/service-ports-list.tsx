import * as React from 'react';
import type { ServiceDetail } from '@swarmy/core';

interface ServicePortsListProps {
  ports: ServiceDetail['ports'];
}

/** Flat mono rows for a service's published ports — empty state sells nothing, just informs. */
export function ServicePortsList({ ports }: ServicePortsListProps): React.JSX.Element {
  return (
    <div>
      <p className="mono-label">Ports</p>
      {ports.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">No published ports.</p>
      ) : (
        <div className="border-border mt-2 divide-y rounded-lg border">
          {ports.map((p, i) => (
            <div key={`${p.target}-${i}`} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="mono-data">
                {p.published ?? '—'} → {p.target}
              </span>
              <span className="text-muted-foreground mono-label !mb-0">{p.protocol}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
