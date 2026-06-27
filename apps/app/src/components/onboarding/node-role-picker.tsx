import * as React from 'react';
import { CrownIcon, ServerIcon } from 'lucide-react';
import { Label, cn } from '@swarmy/ui';

export type NodeRoleChoice = 'auto' | 'manager' | 'worker';

interface RoleOption {
  value: NodeRoleChoice;
  title: string;
  hint: string;
  icon: React.ReactNode;
}

const ROLE_OPTIONS: RoleOption[] = [
  {
    value: 'auto',
    title: 'Automatic',
    hint: 'First node becomes manager; the rest join as workers.',
    icon: <ServerIcon className="size-4" />,
  },
  {
    value: 'manager',
    title: 'Manager',
    hint: 'Runs the swarm control plane. Keep an odd number.',
    icon: <CrownIcon className="size-4" />,
  },
  {
    value: 'worker',
    title: 'Worker',
    hint: 'Runs workloads; joins an existing manager.',
    icon: <ServerIcon className="size-4" />,
  },
];

interface NodeRolePickerProps {
  role: NodeRoleChoice;
  onChange: (role: NodeRoleChoice) => void;
}

/** Segmented role selector — selection carries a 3px coral left rail + soft wash. */
export function NodeRolePicker({ role, onChange }: NodeRolePickerProps): React.JSX.Element {
  return (
    <fieldset className="grid gap-2.5">
      <Label className="mono-label">Node role</Label>
      <div className="grid gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Node role">
        {ROLE_OPTIONS.map((opt) => {
          const selected = role === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={cn(
                'relative flex flex-col gap-1 overflow-hidden rounded-xl border p-3.5 text-left transition-colors',
                selected
                  ? 'bg-accent border-transparent'
                  : 'border-border hover:bg-accent/50',
              )}
            >
              {selected ? (
                <span
                  aria-hidden
                  className="bg-primary absolute inset-y-0 left-0 w-[3px] rounded-r-full"
                />
              ) : null}
              <span className="flex items-center gap-2 text-sm font-bold">
                <span className={cn(selected ? 'text-primary' : 'text-muted-foreground')}>
                  {opt.icon}
                </span>
                {opt.title}
              </span>
              <span className="text-muted-foreground text-xs leading-snug">{opt.hint}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
