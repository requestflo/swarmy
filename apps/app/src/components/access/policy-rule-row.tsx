import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { Button, cn, toast } from '@swarmy/ui';
import { Depth, TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
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

  const tone = !rule.enabled ? 'idle' : rule.effect === 'permit' ? 'ok' : 'warn';
  return (
    <div className="border-border flex min-h-14 flex-wrap items-start gap-x-3 gap-y-2 border-b px-1 py-3 last:border-b-0">
      <span aria-hidden className={cn('mt-[7px] size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <p className={cn('text-[14px] leading-snug font-medium', !rule.enabled && 'text-muted-foreground line-through')}>{rule.sentence}</p>
        <Tech>{`${rule.name} · ${rule.effect} · priority ${rule.priority}${rule.isDefault ? ' · default, kept current by swarmy' : ''}`}</Tech>
      </div>
      <span className={cn('shrink-0 pt-0.5 text-xs font-semibold', TONE_TEXT[tone])}>
        {!rule.enabled ? 'Off' : rule.effect === 'permit' ? 'Allows' : 'Limits'}
      </span>
      <Depth at="controls">
        <QuietSwitch
          aria-label={rule.enabled ? `Turn off: ${rule.sentence}` : `Turn on: ${rule.sentence}`}
          checked={rule.enabled}
          disabled={set.isPending}
          onCheckedChange={(enabled) =>
            set.mutate({ id: rule.id, name: rule.name, effect: rule.effect, source: rule.source, priority: rule.priority, enabled })
          }
        />
        {/* Default rules are managed by swarmy: switch them off, never rewrite them. */}
        {!rule.isDefault && (
          <div className="flex">
            <Button variant="ghost" size="icon" aria-label={`Edit rule ${rule.name}`} onClick={() => onEdit(rule)} className="pointer-coarse:size-11">
              <PencilIcon className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={`Delete rule ${rule.name}`} onClick={() => del.mutate({ id: rule.id })} className="pointer-coarse:size-11">
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        )}
      </Depth>
    </div>
  );
}
