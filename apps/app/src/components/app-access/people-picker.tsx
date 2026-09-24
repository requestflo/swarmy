import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import type { AppAccessPerson } from './types';

interface PeoplePickerProps {
  people: AppAccessPerson[];
  value: string[];
  onChange: (memberIds: string[]) => void;
}

/** Named members. Owners and admins are shown as always-in; everyone else toggles. */
export function PeoplePicker({ people, value, onChange }: PeoplePickerProps): React.JSX.Element {
  const toggle = (id: string): void => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="space-y-2">
      <span className="font-semibold">People</span>
      <div className="divide-border divide-y overflow-hidden rounded-xl border">
        {people.map((p) => {
          const always = p.role === 'owner' || p.role === 'admin';
          const picked = always || value.includes(p.memberId);
          return (
            <button
              type="button"
              key={p.memberId}
              disabled={always}
              onClick={() => toggle(p.memberId)}
              className={cn('hover:bg-accent/60 flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left', picked && 'bg-accent/40')}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{p.name ?? p.email ?? p.memberId}</span>
                <span className="text-muted-foreground mono-label block truncate">
                  {always ? p.role : p.canEnter && !value.includes(p.memberId) ? 'in via a group' : (p.email ?? p.role)}
                </span>
              </span>
              <CheckIcon className={cn('size-4 shrink-0', picked ? 'text-primary' : 'text-transparent')} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
