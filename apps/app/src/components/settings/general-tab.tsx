import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardContent, Input, Label } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Org identity — name, slug, your role. Read-only document surface. */
export function GeneralTab(): React.JSX.Element {
  const trpc = useTRPC();
  const org = useQuery(trpc.org.currentOrg.queryOptions());

  return (
    <Card className="card-pop border-0">
      <CardContent className="grid gap-5 p-5">
        <div>
          <h2 className="font-display text-lg font-semibold">Organization</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Identity for your swarm. This is what nodes and members belong to.
          </p>
        </div>
        <div className="grid max-w-sm gap-4 text-sm">
          <div className="grid gap-1.5">
            <Label className="mono-label">Name</Label>
            <Input value={org.data?.name ?? ''} readOnly />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Slug</Label>
            <Input value={org.data?.slug ?? ''} readOnly />
          </div>
          <div className="flex items-center gap-2">
            <span className="mono-label">Your role</span>
            <Badge variant="muted">{org.data?.role ?? '—'}</Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
