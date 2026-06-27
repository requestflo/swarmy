import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@swarmy/ui';
import type { ModelMount } from '@swarmy/core/compose';

interface MountsEditorProps {
  value: ModelMount[];
  onChange: (next: ModelMount[]) => void;
}

const DEFAULT_MOUNT: ModelMount = { type: 'volume', target: '/data', readOnly: false };

export function MountsEditor({ value, onChange }: MountsEditorProps): React.JSX.Element {
  const patch = (i: number, p: Partial<ModelMount>): void => {
    const next = [...value];
    const cur = next[i];
    if (cur) next[i] = { ...cur, ...p };
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      {value.map((m, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select value={m.type} onValueChange={(v) => patch(i, { type: v as ModelMount['type'] })}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="volume">volume</SelectItem>
              <SelectItem value="bind">bind</SelectItem>
              <SelectItem value="tmpfs">tmpfs</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="font-mono w-40"
            placeholder="source"
            value={m.source ?? ''}
            disabled={m.type === 'tmpfs'}
            onChange={(e) => patch(i, { source: e.target.value || undefined })}
          />
          <span className="text-muted-foreground">:</span>
          <Input
            className="font-mono w-40"
            placeholder="/target"
            value={m.target}
            onChange={(e) => patch(i, { target: e.target.value })}
          />
          <div className="flex items-center gap-1.5">
            <Switch checked={m.readOnly} onCheckedChange={(v) => patch(i, { readOnly: v })} />
            <Label className="mono-label">ro</Label>
          </div>
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
      {value.length === 0 && (
        <p className="text-muted-foreground text-sm">No mounts. Add a volume or bind mount.</p>
      )}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, DEFAULT_MOUNT])}>
          <PlusIcon className="size-4" /> Add
        </Button>
      </div>
    </div>
  );
}
