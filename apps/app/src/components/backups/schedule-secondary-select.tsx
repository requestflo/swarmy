import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { TargetOption } from './target-option';

const NONE = '__none__';

interface SecondaryPickerProps {
  targets: TargetOption[];
  /** The schedule's first destination (excluded from the choices). */
  primaryId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

/** "Also copy to": an optional second destination for every run of a schedule. */
export function SecondaryTargetPicker({
  targets,
  primaryId,
  value,
  onChange,
  disabled,
}: SecondaryPickerProps): React.JSX.Element {
  const others = targets.filter((t) => t.id !== primaryId);
  return (
    <Select
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled || others.length === 0}
    >
      <SelectTrigger>
        <SelectValue placeholder={others.length ? 'No second copy' : 'Add another destination first'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No second copy</SelectItem>
        {others.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Inline "also copy to" control on an existing schedule row. */
export function ScheduleSecondarySelect({
  scheduleId,
  targets,
  primaryId,
  value,
}: {
  scheduleId: string;
  targets: TargetOption[];
  primaryId: string;
  value: string | null;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.backupSchedules.setSecondary.mutationOptions({
      onSuccess: (r) =>
        toast.success(r.secondaryTargetId ? 'Every run now also copies to the second destination' : 'Second copy turned off'),
      onSettled: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="w-44">
      <SecondaryTargetPicker
        targets={targets}
        primaryId={primaryId}
        value={value}
        disabled={set.isPending}
        onChange={(id) => set.mutate({ id: scheduleId, secondaryTargetId: id })}
      />
    </div>
  );
}
