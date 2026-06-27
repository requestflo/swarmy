import * as React from 'react';
import type { ServiceDetail } from '@swarmy/core';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';

interface ServiceConfigPanelProps {
  service: ServiceDetail | undefined;
}

/** Read-only environment + published ports for the running spec. */
export function ServiceConfigPanel({ service }: ServiceConfigPanelProps): React.JSX.Element {
  const env = Object.entries(service?.env ?? {});
  const ports = service?.ports ?? [];

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Environment & ports</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 text-sm">
        <div>
          <p className="mono-label text-muted-foreground mb-2">Environment</p>
          {env.length ? (
            <pre className="bg-muted overflow-x-auto rounded-xl p-3 font-mono text-xs">
              {env.map(([k, v]) => `${k}=${v}`).join('\n')}
            </pre>
          ) : (
            <p className="text-muted-foreground">Nothing set. This service runs clean.</p>
          )}
        </div>
        <div>
          <p className="mono-label text-muted-foreground mb-2">Ports</p>
          {ports.length ? (
            <div className="flex flex-wrap gap-2">
              {ports.map((p, i) => (
                <Badge key={i} variant="outline" className="mono-data">
                  {p.published ? `${p.published}:` : ''}
                  {p.target}/{p.protocol}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No ports published.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
