import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button, Card, CardContent, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@swarmy/ui';
import { BackupVolumeInline } from './backup-volume-inline';
import { SnapshotRows, type SnapshotItem } from './snapshot-rows';
import type { TargetOption } from './target-option';

interface StackSnapshotsCardProps {
  stack: string;
  snapshots: SnapshotItem[];
  targets: TargetOption[];
}

/** This stack's recovery catalog — ad-hoc backup expands inline, never a modal. */
export function StackSnapshotsCard({
  stack,
  snapshots,
  targets,
}: StackSnapshotsCardProps): React.JSX.Element {
  const [backingUp, setBackingUp] = React.useState(false);

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <Collapsible open={backingUp} onOpenChange={setBackingUp}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
            <div>
              <span className="mono-label">Snapshots</span>
              <span className="text-muted-foreground mono-label ml-2">{snapshots.length} in catalog</span>
            </div>
            <CollapsibleTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full font-bold"
                disabled={targets.length === 0}
              >
                <PlusIcon className="size-4" /> Back up now
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <BackupVolumeInline stack={stack} targets={targets} onDone={() => setBackingUp(false)} />
          </CollapsibleContent>
        </Collapsible>
        <SnapshotRows
          rows={snapshots}
          emptyTitle="No snapshots yet."
          emptyDescription={`Back up one of ${stack}'s volumes to start its recovery catalog.`}
        />
      </CardContent>
    </Card>
  );
}
