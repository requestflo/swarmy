import * as React from 'react';
import { ACTION_CATALOG, type ActionInfo } from '@swarmy/abac/model';
import { cn, Label } from '@swarmy/ui';

const GROUP_LABELS: Record<ActionInfo['group'], string> = {
  operate: 'Operate',
  configure: 'Configure',
  access: 'Sensitive access',
  destructive: 'Destructive',
  read: 'Read',
  governance: 'Governance',
};
const ORDER: ActionInfo['group'][] = ['operate', 'configure', 'access', 'destructive', 'read', 'governance'];

interface PolicyActionPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
}

/** Actions as grouped toggle chips; none selected = "anything". */
export function PolicyActionPicker({ value, onChange }: PolicyActionPickerProps): React.JSX.Element {
  const selected = new Set(value);
  const toggle = (id: string): void =>
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="grid gap-3">
      <Label>
        Can… <span className="text-muted-foreground normal-case">(none picked = anything)</span>
      </Label>
      {ORDER.map((group) => (
        <div key={group} className="grid gap-1.5">
          <span className="text-muted-foreground text-xs">{GROUP_LABELS[group]}</span>
          <div className="flex flex-wrap gap-1.5">
            {ACTION_CATALOG.filter((a) => a.group === group).map((a) => (
              <button
                key={a.id}
                type="button"
                aria-pressed={selected.has(a.id)}
                title={a.id}
                onClick={() => toggle(a.id)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  selected.has(a.id)
                    ? group === 'destructive'
                      ? 'border-destructive bg-destructive/10 text-destructive'
                      : 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
