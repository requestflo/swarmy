import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertRuleView, AlertSignal } from '@swarmy/core';
import { ALERT_SIGNAL_INFO } from '@swarmy/core';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Edit one rule: threshold, for-duration and channel bindings. */
export function EditRuleDialog({
  rule,
  onClose,
}: {
  rule: AlertRuleView | null;
  onClose: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const channels = useQuery(trpc.alerts.channels.queryOptions());

  const [threshold, setThreshold] = React.useState('');
  const [forSeconds, setForSeconds] = React.useState('0');
  const [channelIds, setChannelIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!rule) return;
    setThreshold(rule.threshold !== null ? String(rule.threshold) : '');
    setForSeconds(String(rule.forSeconds));
    setChannelIds(rule.channelIds);
  }, [rule]);

  const save = useMutation(
    trpc.alerts.updateRule.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.name} updated.`);
        onClose();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const info = rule ? ALERT_SIGNAL_INFO[rule.signal as AlertSignal] : undefined;
  const hasThreshold = Boolean(info?.unit);
  const parsedThreshold = Number(threshold);
  const parsedFor = Number.parseInt(forSeconds, 10);
  const ready =
    (!hasThreshold || (threshold.trim() !== '' && Number.isFinite(parsedThreshold))) &&
    Number.isInteger(parsedFor) &&
    parsedFor >= 0;

  const toggleChannel = (id: string): void =>
    setChannelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <Dialog open={rule !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit “{rule?.name}”</DialogTitle>
          <DialogDescription>{info?.description ?? 'Tune when this rule fires.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {hasThreshold ? (
            <div className="space-y-2">
              <Label htmlFor="rule-threshold">Threshold ({info?.unit})</Label>
              <Input
                id="rule-threshold"
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="rule-for">Must persist for (seconds)</Label>
            <Input
              id="rule-for"
              type="number"
              min={0}
              value={forSeconds}
              onChange={(e) => setForSeconds(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              0 fires immediately; 60 waits until the condition has held for a minute.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Notify channels</Label>
            {(channels.data ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No channels yet — add one in the Channels panel first.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(channels.data ?? []).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleChannel(c.id)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                      channelIds.includes(c.id)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              Select none to notify every enabled channel.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!ready || save.isPending}
            onClick={() =>
              rule &&
              save.mutate({
                id: rule.id,
                threshold: hasThreshold ? parsedThreshold : null,
                forSeconds: parsedFor,
                channelIds,
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
