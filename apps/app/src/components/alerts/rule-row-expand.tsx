import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertRuleView } from '@swarmy/core';
import { Button, Input, Label, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { signalInfo } from './alert-tones';

/** Inline edit form for one rule: threshold, for-duration and channel bindings. */
export function RuleRowExpand({ rule }: { rule: AlertRuleView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const channels = useQuery(trpc.alerts.channels.queryOptions());

  const [threshold, setThreshold] = React.useState(rule.threshold !== null ? String(rule.threshold) : '');
  const [forSeconds, setForSeconds] = React.useState(String(rule.forSeconds));
  const [channelIds, setChannelIds] = React.useState<string[]>(rule.channelIds);

  const info = signalInfo(rule.signal);
  const hasThreshold = Boolean(info.unit);
  const parsedThreshold = Number(threshold);
  const parsedFor = Number.parseInt(forSeconds, 10);
  const ready =
    (!hasThreshold || (threshold.trim() !== '' && Number.isFinite(parsedThreshold))) &&
    Number.isInteger(parsedFor) &&
    parsedFor >= 0;

  const save = useMutation(
    trpc.alerts.updateRule.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.name} updated.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const toggleChannel = (id: string): void =>
    setChannelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <div className="border-border space-y-4 border-t px-5 py-5">
      <p className="text-muted-foreground text-xs">{info.description || 'Tune when this rule fires.'}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {hasThreshold ? (
          <div className="space-y-2">
            <Label htmlFor={`th-${rule.id}`}>Threshold ({info.unit})</Label>
            <Input
              id={`th-${rule.id}`}
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`for-${rule.id}`}>Must persist for (seconds)</Label>
          <Input
            id={`for-${rule.id}`}
            type="number"
            min={0}
            value={forSeconds}
            onChange={(e) => setForSeconds(e.target.value)}
          />
        </div>
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
        <p className="text-muted-foreground text-xs">Select none to notify every enabled channel.</p>
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!ready || save.isPending}
          onClick={() =>
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
      </div>
    </div>
  );
}
