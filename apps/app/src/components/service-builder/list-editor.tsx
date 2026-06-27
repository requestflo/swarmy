import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';

interface ListEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyHint?: string;
}

/** Generic string[] editor (networks, command, constraints). */
export function ListEditor({
  value,
  onChange,
  placeholder,
  emptyHint = 'Nothing here yet.',
}: ListEditorProps): React.JSX.Element {
  return (
    <div className="grid gap-2">
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="font-mono"
            placeholder={placeholder}
            value={item}
            onChange={(e) => {
              const next = [...value];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      ))}
      {value.length === 0 && <p className="text-muted-foreground text-sm">{emptyHint}</p>}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, ''])}>
          <PlusIcon className="size-4" /> Add
        </Button>
      </div>
    </div>
  );
}
