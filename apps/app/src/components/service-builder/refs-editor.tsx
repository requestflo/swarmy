import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Button, Input, Label } from '@swarmy/ui';
import type { ModelConfigSecretRef } from '@swarmy/core/compose';

interface RefsEditorProps {
  value: ModelConfigSecretRef[];
  onChange: (next: ModelConfigSecretRef[]) => void;
  /** Singular noun for the empty hint ("config" / "secret"). */
  noun: string;
}

/** Editor for Swarm config/secret references (source + optional target/mode). */
export function RefsEditor({ value, onChange, noun }: RefsEditorProps): React.JSX.Element {
  const patch = (i: number, p: Partial<ModelConfigSecretRef>): void => {
    const next = [...value];
    const cur = next[i];
    if (cur) next[i] = { ...cur, ...p };
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      {value.map((ref, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            className="font-mono w-44"
            placeholder={`${noun} name`}
            value={ref.source}
            onChange={(e) => patch(i, { source: e.target.value })}
          />
          <span className="text-muted-foreground">→</span>
          <Input
            className="font-mono w-48"
            placeholder="/run/secrets/… (target)"
            value={ref.target ?? ''}
            onChange={(e) => patch(i, { target: e.target.value || undefined })}
          />
          <div className="flex items-center gap-1.5">
            <Label className="mono-label">mode</Label>
            <Input
              className="font-mono w-24"
              placeholder="0444"
              value={ref.mode != null ? ref.mode.toString(8).padStart(4, '0') : ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                patch(i, { mode: v ? parseInt(v, 8) : undefined });
              }}
            />
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <XIcon className="size-4" />
          </Button>
        </div>
      ))}
      {value.length === 0 && (
        <p className="text-muted-foreground text-sm">No {noun}s mounted.</p>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...value, { source: '' }])}
        >
          <PlusIcon className="size-4" /> Add {noun}
        </Button>
      </div>
    </div>
  );
}
