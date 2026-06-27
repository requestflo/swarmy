import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon } from 'lucide-react';
import { Button, Card, CardContent, StatusBadge, type StatusTone, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CountUp } from '@/components/count-up';

interface StackRow {
  id: string;
  name: string;
  serviceCount: number;
  status: string;
  updatedAt: string;
}

function toneFor(status: string): StatusTone {
  if (status === 'running') return 'online';
  if (status === 'failed') return 'offline';
  if (status === 'deploying' || status === 'pending') return 'progress';
  return 'neutral';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Flat stack rows inside one card-pop, divided by hairlines. */
export function StacksList({ stacks }: { stacks: StackRow[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const remove = useMutation(
    trpc.stacks.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Stack removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const total = stacks.length;
  const running = stacks.filter((s) => s.status === 'running').length;

  return (
    <Card className="card-pop border-0">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <span className="mono-label">
            <CountUp value={running} /> / {total} running
          </span>
          <span className="text-muted-foreground mono-label">{total} total</span>
        </div>
        <div className="divide-border divide-y border-t">
          {stacks.map((stack) => {
            const tone = toneFor(stack.status);
            return (
              <div
                key={stack.id}
                className="hover:bg-accent/60 flex items-center gap-4 px-6 py-4 transition-colors"
              >
                <StatusBadge tone={tone} label="" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{stack.name}</p>
                  <p className="text-muted-foreground mono-label truncate">
                    {stack.status} · {relativeTime(stack.updatedAt)}
                  </p>
                </div>
                <div className="hidden w-32 text-right sm:block">
                  <p className="mono-data text-sm">{stack.serviceCount}</p>
                  <p className="text-muted-foreground mono-label">services</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${stack.name}`}
                  onClick={() => remove.mutate({ id: stack.id })}
                  disabled={remove.isPending}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
