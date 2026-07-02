import * as React from 'react';
import { Card, CardContent } from '@swarmy/ui';

/**
 * Temporary tab body while a workspace surface is being relocated in. Each
 * stub is replaced by the real stack-scoped surface — if you can still see
 * this component in the app, a relocation slice hasn't landed.
 */
export function WorkspaceStub({ title }: { title: string }): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardContent className="space-y-3 p-6">
        <p className="text-muted-foreground text-sm font-medium">{title}</p>
        <div className="shimmer-line h-4 w-2/3 rounded" />
        <div className="shimmer-line h-4 w-1/2 rounded" />
        <div className="shimmer-line h-4 w-3/5 rounded" />
      </CardContent>
    </Card>
  );
}
