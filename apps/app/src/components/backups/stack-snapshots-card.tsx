import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { BackupVolumeInline } from './backup-volume-inline';
import { SnapshotRows, type SnapshotItem } from './snapshot-rows';
import type { TargetOption } from './target-option';

interface StackSnapshotsCardProps {
  stack: string;
  snapshots: SnapshotItem[];
  targets: TargetOption[];
}

/** This app's restore points — an ad-hoc save expands inline, never a modal. */
export function StackSnapshotsCard({ stack, snapshots, targets }: StackSnapshotsCardProps): React.JSX.Element {
  const [backingUp, setBackingUp] = React.useState(false);
  return (
    <Collapsible open={backingUp} onOpenChange={setBackingUp}>
      <Section
        title="Restore points"
        count={`${snapshots.length} kept`}
        flush
        action={
          <CollapsibleTrigger asChild>
            <Button size="sm" variant="outline" disabled={targets.length === 0}>
              <PlusIcon className="size-4" /> Back up now
            </Button>
          </CollapsibleTrigger>
        }
      >
        <CollapsibleContent>
          <BackupVolumeInline stack={stack} targets={targets} onDone={() => setBackingUp(false)} />
        </CollapsibleContent>
        <SnapshotRows
          rows={snapshots}
          emptyTitle="No restore points yet"
          emptyDescription={`${stack}'s volumes are saved nightly; the first restore points land after tonight. Or back one up now.`}
        />
      </Section>
    </Collapsible>
  );
}
