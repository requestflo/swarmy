import * as React from 'react';
import { FileCode2Icon } from 'lucide-react';
import { cn, Input, Label } from '@swarmy/ui';
import { GitComposeDraft } from './git-compose-draft';
import { useInspectSource } from './use-inspect-source';

interface GitConfigPathFieldProps {
  source: { connectionId?: string; cloneUrl: string; ref: string };
  value: string;
  onChange: (configPath: string) => void;
}

const where = (p: string): string => p.replace(/\/?swarmy\.ya?ml$/, '') || 'the repo root';

/** Which swarmy.yaml this app deploys — the ones we find in the repo, or a typed path. */
export function GitConfigPathField({
  source,
  value,
  onChange,
}: GitConfigPathFieldProps): React.JSX.Element {
  const found = useInspectSource(source);
  const paths = found.data?.configPaths ?? [];
  const current = value || 'swarmy.yaml';

  return (
    <div className="space-y-2">
      {found.isFetching ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <span className="pulse-dot" /> Looking for swarmy.yaml on {source.ref}…
        </p>
      ) : found.isError ? (
        <p className="text-muted-foreground text-sm">
          Couldn’t look inside yet ({found.error.message}). Type the path if it isn’t at the root.
        </p>
      ) : found.data && paths.length === 0 && found.data.composeDraft ? (
        <GitComposeDraft draft={found.data.composeDraft} />
      ) : found.data && paths.length === 0 ? (
        <p className="text-sm">
          No swarmy.yaml on {source.ref} yet — add one and push, or type where it’ll live.
        </p>
      ) : null}
      {paths.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {paths.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              aria-pressed={current === p}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                current === p ? 'border-primary bg-accent' : 'hover:bg-accent/60',
              )}
            >
              <FileCode2Icon className="text-status-online size-3.5" />
              <span className="mono-data">{where(p)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <Label className="text-muted-foreground text-xs">Path to swarmy.yaml</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="swarmy.yaml"
        className="mono-data"
      />
    </div>
  );
}
