import * as React from 'react';
import { LinkIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { KIND_LABEL, type GitConnection } from './git-types';

/** `null` = "Any git URL" (no connection). */
export type GitSource = { connection: GitConnection } | null;

interface GitSourcePickerProps {
  connections: GitConnection[];
  value: GitSource | undefined;
  onChange: (source: GitSource) => void;
}

function Choice({
  active,
  onClick,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  title: React.ReactNode;
  sub: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-xl border px-4 py-3 text-left transition-colors',
        active ? 'border-primary bg-accent' : 'hover:bg-accent/60',
      )}
    >
      <span className="block truncate font-medium">{title}</span>
      <span className="text-muted-foreground mono-label block truncate">{sub}</span>
    </button>
  );
}

/** Step 1 — where the code lives: one of the connections, or a typed git URL. */
export function GitSourcePicker({
  connections,
  value,
  onChange,
}: GitSourcePickerProps): React.JSX.Element {
  const usable = connections.filter((c) => c.status === 'active');
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {usable.map((c) => (
        <Choice
          key={c.id}
          active={value?.connection.id === c.id}
          onClick={() => onChange({ connection: c })}
          title={c.displayName}
          sub={`${KIND_LABEL[c.kind]}${c.account ? ` · ${c.account}` : ''}`}
        />
      ))}
      <Choice
        active={value === null}
        onClick={() => onChange(null)}
        title={
          <span className="inline-flex items-center gap-2">
            <LinkIcon className="size-4" /> Any git URL
          </span>
        }
        sub="public repo or SSH remote"
      />
    </div>
  );
}
