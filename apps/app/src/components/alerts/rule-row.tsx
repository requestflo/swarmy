import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import { Button, Collapsible, CollapsibleContent, cn, toast } from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';
import { CalmRow, Depth } from '@/components/calm';
import { signalInfo } from './alert-tones';
import { ruleSentence } from './alert-sentence';
import { RuleRowExpand } from './rule-row-expand';

interface RuleRowProps {
  rule: AlertRuleView;
  channels: NotificationChannelView[];
  expanded: boolean;
  onToggle: () => void;
}

/** One rule: the plain sentence at Summary; the on/off switch, thresholds and inline edit from Controls. */
export function RuleRow({ rule, channels, expanded, onToggle }: RuleRowProps): React.JSX.Element {
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
  const { unit } = signalInfo(rule.signal);
  const tech = `${rule.signal}${rule.threshold !== null ? ` ≥ ${rule.threshold}${unit ?? ''}` : ''} · for ${rule.forSeconds}s`;

  return (
    <div className={cn(expanded && 'bg-accent/40 rounded-md')}>
      <CalmRow
        tone={rule.enabled ? 'ok' : 'idle'}
        name={rule.name}
        say={ruleSentence(rule, channels)}
        tech={tech}
        word={rule.enabled ? 'On' : 'Off'}
        trailing={
          <Depth at="controls">
            <QuietSwitch
              checked={rule.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enabled) => toggle.mutate({ id: rule.id, enabled })}
              aria-label={`Turn ${rule.name} ${rule.enabled ? 'off' : 'on'}`}
            />
            <Button variant="ghost" size="icon" aria-label={`Edit ${rule.name}`} aria-expanded={expanded} onClick={onToggle} className="pointer-coarse:size-11">
              <ChevronDownIcon className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
            </Button>
          </Depth>
        }
      />
      <Depth at="controls">
        <Collapsible open={expanded}>
          <CollapsibleContent>
            <RuleRowExpand rule={rule} />
          </CollapsibleContent>
        </Collapsible>
      </Depth>
    </div>
  );
}
