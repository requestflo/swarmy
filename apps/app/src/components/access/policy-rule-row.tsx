import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { Badge, Button, StatusBadge, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { PolicyRow } from './use-policy-editor';

interface PolicyRuleRowProps {
  rule: PolicyRow;
  onEdit: (rule: PolicyRow) => void;
}

/** One rule, read as a sentence, with enable / edit / delete. */
export function PolicyRuleRow({ rule, onEdit }: PolicyRuleRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const onError = (e: { message: string }): void => void toast.error(e.message);
  const done = (): void => void qc.invalidateQueries();
  const set = useMutation(trpc.policies.set.mutationOptions({ onSuccess: done, onError }));
  const del = useMutation(
    trpc.policies.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Rule deleted');
        done();
      },
      onError,
    }),
  );

  return (
    <div className="hover:bg-accent/60 flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-4 transition-colors">
      <div className="min-w-0 flex-1 basis-72">
        <p className={rule.enabled ? 'font-medium' : 'text-muted-foreground font-medium line-through'}>{rule.sentence}</p>
        <p className="text-muted-foreground mono-label mt-1 flex flex-wrap items-center gap-2">
          <span className="truncate">{rule.name}</span>
          <span>· priority {rule.priority}</span>
          {rule.isDefault && <Badge variant="muted">default</Badge>}
        </p>
      </div>
      <StatusBadge tone={rule.effect === 'permit' ? 'online' : 'offline'} label={rule.effect === 'permit' ? 'can' : 'never'} />
      <Switch
        aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
        checked={rule.enabled}
        disabled={set.isPending}
        onCheckedChange={(enabled) =>
          set.mutate({ id: rule.id, name: rule.name, effect: rule.effect, source: rule.source, priority: rule.priority, enabled })
        }
      />
      <div className="flex">
        <Button variant="ghost" size="sm" aria-label="Edit rule" onClick={() => onEdit(rule)}>
          <PencilIcon className="size-4" />
        </Button>
        {!rule.isDefault && (
          <Button variant="ghost" size="sm" aria-label="Delete rule" onClick={() => del.mutate({ id: rule.id })}>
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
