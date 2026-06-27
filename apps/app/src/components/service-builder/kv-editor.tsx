import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';

interface KvEditorProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyHint?: string;
}

/** Generic Record<string,string> editor (env, labels). Order-preserving. */
export function KvEditor({
  value,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value',
  emptyHint = 'Nothing here yet.',
}: KvEditorProps): React.JSX.Element {
  const rows = React.useMemo(() => Object.entries(value), [value]);

  const update = (entries: [string, string][]): void => {
    const out: Record<string, string> = {};
    for (const [k, v] of entries) if (k) out[k] = v;
    onChange(out);
  };

  return (
    <div className="grid gap-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="font-mono"
            placeholder={keyPlaceholder}
            value={k}
            onChange={(e) => {
              const next = [...rows];
              next[i] = [e.target.value, v];
              update(next);
            }}
          />
          <Input
            className="font-mono"
            placeholder={valuePlaceholder}
            value={v}
            onChange={(e) => {
              const next = [...rows];
              next[i] = [k, e.target.value];
              update(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => update(rows.filter((_, j) => j !== i))}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-muted-foreground text-sm">{emptyHint}</p>}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => update([...rows, ['', '']])}>
          <PlusIcon className="size-4" /> Add
        </Button>
      </div>
    </div>
  );
}
