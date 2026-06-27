import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import type { ModelPort } from '@swarmy/core/compose';

interface PortsEditorProps {
  value: ModelPort[];
  onChange: (next: ModelPort[]) => void;
}

const DEFAULT_PORT: ModelPort = { target: 80, protocol: 'tcp', mode: 'ingress' };

export function PortsEditor({ value, onChange }: PortsEditorProps): React.JSX.Element {
  const patch = (i: number, p: Partial<ModelPort>): void => {
    const next = [...value];
    const cur = next[i];
    if (cur) next[i] = { ...cur, ...p };
    onChange(next);
  };

  return (
    <div className="grid gap-2">
      {value.map((port, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            placeholder="published"
            className="mono-data w-28"
            value={port.published ?? ''}
            onChange={(e) =>
              patch(i, { published: e.target.value ? Number(e.target.value) : undefined })
            }
          />
          <span className="text-muted-foreground">→</span>
          <Input
            type="number"
            placeholder="target"
            className="mono-data w-28"
            value={port.target}
            onChange={(e) => patch(i, { target: Number(e.target.value) })}
          />
          <Select value={port.protocol} onValueChange={(v) => patch(i, { protocol: v as 'tcp' | 'udp' })}>
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="tcp">tcp</SelectItem>
              <SelectItem value="udp">udp</SelectItem>
            </SelectContent>
          </Select>
          <Select value={port.mode} onValueChange={(v) => patch(i, { mode: v as 'ingress' | 'host' })}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ingress">ingress</SelectItem>
              <SelectItem value="host">host</SelectItem>
            </SelectContent>
          </Select>
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
        <p className="text-muted-foreground text-sm">No published ports. Add one to expose a port.</p>
      )}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, DEFAULT_PORT])}>
          <PlusIcon className="size-4" /> Add
        </Button>
      </div>
    </div>
  );
}
