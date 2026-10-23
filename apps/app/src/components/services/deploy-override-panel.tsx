import * as React from 'react';
import { Loader2Icon } from 'lucide-react';
import { Button, Label, Textarea } from '@swarmy/ui';
import { StatusWord, Tech } from '@/components/calm';
import type { PolicyRefusal } from './policy-refusal';

/**
 * What a refused deploy says on /services/new: each finding in plain words,
 * then the way through. A blocking guardrail needs an admin or owner and a
 * written reason (both checked again server-side, and audited as
 * `service.deploy.override`); a warning any member may confirm.
 */
export function DeployOverridePanel({
  refusal,
  isAdmin,
  pending,
  onDeployAnyway,
}: {
  refusal: PolicyRefusal;
  /** Undefined while the role is still loading. */
  isAdmin: boolean | undefined;
  pending: boolean;
  onDeployAnyway: (reason: string) => void;
}): React.JSX.Element {
  const [reason, setReason] = React.useState('');
  const reasonId = React.useId();
  const { blocking, violations } = refusal;
  const canOverride = !blocking || isAdmin === true;
  const ready = !blocking || reason.trim().length > 0;

  return (
    <section role="alert" aria-label="Deploy stopped" className="calm-card flex flex-col gap-4 px-5 py-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-[1.2rem] font-bold tracking-[-0.01em]">
          {blocking ? 'A guardrail stopped this deploy.' : 'This deploy has a warning.'}
        </h2>
        <StatusWord tone={blocking ? 'bad' : 'warn'} word={blocking ? 'Stopped' : 'Check first'} />
      </div>
      <ul className="flex flex-col gap-2">
        {violations.map((v) => (
          <li key={`${v.rule}:${v.resource ?? ''}`} className="flex flex-col gap-0.5">
            <p className="text-[14px] leading-snug">{v.message}</p>
            <Tech>{`${v.rule} · ${v.severity}${v.resource ? ` · ${v.resource}` : ''}`}</Tech>
          </li>
        ))}
      </ul>
      {canOverride ? (
        <div className="flex flex-col gap-2 border-t pt-4">
          <Label htmlFor={reasonId} className="text-sm font-medium">
            {blocking ? 'Why deploy anyway?' : 'Anything to note? (optional)'}
          </Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            rows={2}
            required={blocking}
            placeholder={blocking ? 'Hotfix for the checkout outage; pinning the tag tomorrow.' : ''}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Your name and this reason go in the audit log and the guardrails history.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={pending || !ready}
            onClick={() => onDeployAnyway(reason.trim())}
            className="pointer-coarse:min-h-11 self-start"
          >
            {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Deploy anyway
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground border-t pt-4 text-sm">
          {isAdmin === undefined
            ? 'Checking whether you can deploy past this…'
            : 'Only an admin or owner can deploy past this. Fix what it found, or ask one of them.'}
        </p>
      )}
    </section>
  );
}
