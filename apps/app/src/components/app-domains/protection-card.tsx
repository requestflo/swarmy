import * as React from 'react';
import { Button, Input, Switch, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';

/** One protection card (board 30): title and switch, the sentence, its knobs, the Caddy line. */
export function ProtectionCard({ title, on, disabled, onToggle, say, tech, children }: {
  title: string;
  on: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
  say: string;
  tech: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className={cn('calm-card flex flex-col gap-2 px-4 py-3 transition-colors', on && 'border-primary/40')}>
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="flex-1 text-[13.5px] font-semibold">{title}</label>
        <Switch id={id} checked={on} disabled={disabled} onCheckedChange={onToggle} />
      </div>
      <p className={cn('text-[12.5px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>{say}</p>
      {children}
      <Tech>{tech}</Tech>
    </div>
  );
}

/**
 * The typed part of a rule (countries, addresses, upload size): shown at
 * Controls, or as soon as the switch is turned on with nothing typed yet.
 */
export function RuleFields({ fields, saving, onSave, onCancel }: {
  fields: Array<{ label: string; value: string; placeholder: string; onChange: (v: string) => void }>;
  saving: boolean;
  onSave: () => void;
  onCancel?: () => void;
}): React.JSX.Element {
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      {fields.map((f) => (
        <Input key={f.label} aria-label={f.label} value={f.value} placeholder={f.placeholder} onChange={(e) => f.onChange(e.target.value)} className="h-8 font-mono text-[12px]" />
      ))}
      <div className="flex justify-end gap-1.5">
        {onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button> : null}
        <Button type="submit" variant="outline" size="sm" disabled={saving}>Save</Button>
      </div>
    </form>
  );
}
