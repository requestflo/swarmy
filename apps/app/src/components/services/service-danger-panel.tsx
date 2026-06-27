import * as React from 'react';
import { Trash2Icon } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';

interface ServiceDangerPanelProps {
  onRemove: () => void;
  removing: boolean;
}

/** Destructive zone — stops every replica and deletes the service. */
export function ServiceDangerPanel({ onRemove, removing }: ServiceDangerPanelProps): React.JSX.Element {
  return (
    <Card className="card-pop border-status-offline/40 mt-6 border">
      <CardHeader>
        <CardTitle className="text-status-offline text-base">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="text-sm">
          <p className="font-medium">Remove this service</p>
          <p className="text-muted-foreground">Stops every replica and deletes the service. No undo.</p>
        </div>
        <Button
          variant="destructive"
          className="rounded-full font-bold"
          onClick={onRemove}
          disabled={removing}
        >
          <Trash2Icon className="size-4" /> Remove
        </Button>
      </CardContent>
    </Card>
  );
}
