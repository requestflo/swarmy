import * as React from 'react';
import { CONFIG_NAME_TEMPLATES } from '@swarmy/core';
import { Input, Label, cn } from '@swarmy/ui';

interface ConfigNameFieldsProps {
  family: string;
  mountPath: string;
  onFamily: (next: string) => void;
  onMountPath: (next: string) => void;
}

/** Template chips + name + mount-path inputs shared by the create card. */
export function ConfigNameFields({
  family,
  mountPath,
  onFamily,
  onMountPath,
}: ConfigNameFieldsProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {CONFIG_NAME_TEMPLATES.map((t) => (
          <button
            key={t.family}
            type="button"
            onClick={() => {
              onFamily(t.family);
              onMountPath(t.mountPath);
            }}
            className={cn(
              'mono-data rounded-full border border-border px-2.5 py-1 text-[11px] transition-colors',
              family === t.family
                ? 'bg-primary/10 border-primary/40 text-primary font-semibold'
                : 'hover:bg-accent text-muted-foreground',
            )}
          >
            {t.family}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label className="mono-label">Name</Label>
          <Input
            value={family}
            onChange={(e) => onFamily(e.target.value)}
            placeholder="app-config"
            className="mono-data"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Mount path (optional)</Label>
          <Input
            value={mountPath}
            onChange={(e) => onMountPath(e.target.value)}
            placeholder="/etc/app/config.yaml"
            className="mono-data"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}
