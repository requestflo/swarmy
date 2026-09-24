import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Input } from '@swarmy/ui';

interface GroupPickerProps {
  known: string[];
  value: string[];
  onChange: (groups: string[]) => void;
}

/** Groups (SSO group claims + teams) as removable chips; type a name to add one. */
export function GroupPicker({ known, value, onChange }: GroupPickerProps): React.JSX.Element {
  const [text, setText] = React.useState('');
  const add = (g: string): void => {
    const name = g.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setText('');
  };
  const suggestions = known.filter((g) => !value.includes(g));
  return (
    <div className="space-y-2">
      <span className="font-semibold">Groups</span>
      <p className="text-muted-foreground text-sm">SSO groups and teams. Everyone in a listed group can enter.</p>
      <div className="flex flex-wrap gap-2">
        {value.map((g) => (
          <span key={g} className="bg-accent mono-data flex items-center gap-1 rounded-full px-3 py-1 text-sm">
            {g}
            <button type="button" aria-label={`Remove ${g}`} onClick={() => onChange(value.filter((x) => x !== g))}>
              <XIcon className="size-3.5" />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(text);
        }}
      >
        <Input className="max-w-xs" list="app-access-groups" value={text} placeholder="Add a group, e.g. engineering" onChange={(e) => setText(e.target.value)} />
        <datalist id="app-access-groups">
          {suggestions.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </form>
    </div>
  );
}
