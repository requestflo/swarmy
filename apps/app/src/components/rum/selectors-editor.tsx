import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';

interface SelectorsEditorProps {
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}

const MAX = 20;
const BAD = /[<>"`{}\\\n]/;

/** CSS selectors the recorder skips entirely (`.card-number`, `[data-private]`, `iframe`). */
export function SelectorsEditor({ value, onChange, disabled }: SelectorsEditorProps): React.JSX.Element {
  const [draft, setDraft] = React.useState('');
  const sel = draft.trim();
  const error = sel && BAD.test(sel) ? 'No < > " ` { } or \\ in a selector.' : value.includes(sel) ? 'Already listed.' : null;
  const add = (): void => {
    if (!sel || error || value.length >= MAX) return;
    onChange([...value, sel]);
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 ? <span className="text-muted-foreground text-xs">Nothing blocked yet.</span> : null}
        {value.map((v) => (
          <span key={v} className="bg-muted inline-flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 font-mono text-xs">
            {v}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((x) => x !== v))}
              aria-label={`Stop blocking ${v}`}
              className="hover:bg-accent rounded-full p-0.5"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder=".card-number"
          disabled={disabled || value.length >= MAX}
          aria-label="CSS selector to never record"
          aria-invalid={!!error}
          className="h-8 max-w-xs font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="outline" className="rounded-full" disabled={disabled || !sel || !!error}>
          Block
        </Button>
      </form>
      {error ? <span className="text-status-offline text-xs">{error}</span> : null}
    </div>
  );
}
