import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import type { AlertRuleView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, Switch, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { forDuration, signalInfo } from './alert-tones';
import { RuleRowExpand } from './rule-row-expand';

interface RuleRowProps {
  rule: AlertRuleView;
  expanded: boolean;
  onToggle: () => void;
}

/** One rule row: enable toggle + threshold/channel summary; expands to edit inline. */
export function RuleRow({ rule, expanded, onToggle }: RuleRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toggle = useMutation(
    trpc.alerts.updateRule.mutationOptions({
      onSuccess: (r) => {
        toast.success(`${r.name} ${r.enabled ? 'enabled' : 'muted'}.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const info = signalInfo(rule.signal);

  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-5 py-3 lg:grid-cols-[1.6fr_7rem_6rem_6rem_3.5rem_2.5rem]">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{rule.name}</span>
          <span className="mono-data text-muted-foreground block truncate text-xs">{rule.signal}</span>
        </span>
        <span className="mono-data hidden text-right text-sm lg:block">
          {rule.threshold !== null ? `${rule.threshold}${info.unit ?? ''}` : '—'}
        </span>
        <span className="mono-data text-muted-foreground hidden text-right text-xs lg:block">
          {forDuration(rule.forSeconds)}
        </span>
        <span className="text-muted-foreground hidden text-right text-xs lg:block">
          {rule.channelIds.length === 0 ? 'all' : rule.channelIds.length}
        </span>
        <span className="flex justify-end">
          <Switch
            checked={rule.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate({ id: rule.id, enabled })}
            aria-label={`Toggle ${rule.name}`}
          />
        </span>
        <span className="flex justify-end">
          <Button variant="ghost" size="icon" aria-label={`Edit ${rule.name}`} onClick={onToggle}>
            <ChevronDownIcon className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </Button>
        </span>
      </div>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <RuleRowExpand rule={rule} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
