import * as React from 'react';
import { HardDriveIcon, PlusIcon } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Button,
  EmptyState,
  StatusBadge,
} from '@swarmy/ui';
import { AddTargetForm } from './add-target-form';
import { RemoveTargetConfirm } from './remove-target-confirm';

export interface TargetRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  hasCredentials: boolean;
  enabled: boolean;
}

function repoPath(target: TargetRow): string {
  const endpoint = target.endpoint ? `${target.endpoint}/` : '';
  const prefix = target.prefix ? `/${target.prefix}` : '';
  return `${endpoint}${target.bucket}${prefix}`;
}

/** Destinations as flat hairline rows; adding expands inline — never a modal. */
export function DestinationsCard({ targets }: { targets: TargetRow[] }): React.JSX.Element {
  const [adding, setAdding] = React.useState(false);

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <Collapsible open={adding} onOpenChange={setAdding}>
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
            <span className="mono-label">Destinations</span>
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-full font-bold">
                <PlusIcon className="size-4" /> Add destination
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <AddTargetForm onDone={() => setAdding(false)} />
          </CollapsibleContent>
        </Collapsible>
        {targets.length === 0 ? (
          <div className="border-t px-6 py-2">
            <EmptyState
              className="border-0"
              icon={<HardDriveIcon />}
              title="No destinations yet."
              description="Add an S3 bucket or node path — or use swarmy object storage above — and every snapshot lands there, encrypted."
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {targets.map((target) => (
              <div
                key={target.id}
                className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
              >
                <StatusBadge tone={target.enabled ? 'online' : 'neutral'} label="" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{target.name}</p>
                    <Badge variant="muted" className="mono-label">
                      {target.kind}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mono-label truncate">{repoPath(target)}</p>
                </div>
                <Badge
                  variant={target.hasCredentials ? 'secondary' : 'muted'}
                  className="hidden sm:inline-flex"
                >
                  {target.hasCredentials ? 'keyed' : 'no creds'}
                </Badge>
                <RemoveTargetConfirm id={target.id} name={target.name} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
