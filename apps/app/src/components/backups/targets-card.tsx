import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HardDriveIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  StatusBadge,
  type StatusTone,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AddTargetDialog } from '@/components/backups/add-target-dialog';

interface TargetRow {
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

/** Flat target rows inside one card-pop, divided by hairlines. */
export function TargetsCard({ targets }: { targets: TargetRow[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const remove = useMutation(
    trpc.backups.removeTarget.mutationOptions({
      onSuccess: () => {
        toast.success('Target removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <span className="mono-label">Targets</span>
          <AddTargetDialog />
        </div>
        {targets.length === 0 ? (
          <div className="border-t px-6 py-2">
            <EmptyState
              className="border-0"
              icon={<HardDriveIcon />}
              title="No targets yet."
              description="Add an S3-compatible bucket and start protecting your volumes — every snapshot lands here, encrypted."
              action={<AddTargetDialog />}
            />
          </div>
        ) : (
          <div className="divide-border divide-y border-t">
            {targets.map((target) => {
              const tone: StatusTone = target.enabled ? 'online' : 'neutral';
              return (
                <div
                  key={target.id}
                  className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
                >
                  <StatusBadge tone={tone} label="" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{target.name}</p>
                      <Badge variant="muted" className="mono-label">
                        {target.kind}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mono-label truncate">{repoPath(target)}</p>
                  </div>
                  <Badge variant={target.hasCredentials ? 'secondary' : 'muted'} className="hidden sm:inline-flex">
                    {target.hasCredentials ? 'keyed' : 'no creds'}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${target.name}`}
                    onClick={() => remove.mutate({ id: target.id })}
                    disabled={remove.isPending}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
