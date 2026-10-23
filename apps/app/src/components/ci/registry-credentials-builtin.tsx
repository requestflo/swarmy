import * as React from 'react';
import { Badge, StatusBadge, cn } from '@swarmy/ui';

interface BuiltinRegistry {
  enabled: boolean;
  host: string | null;
  online: boolean;
}

interface RegistryCredentialsBuiltinProps {
  config: BuiltinRegistry | undefined;
  /** The image being checked resolves here (highlights the row). */
  hit?: boolean;
}

/** The in-swarm registry, listed first: it never needs a saved login. */
export function RegistryCredentialsBuiltin({ config, hit }: RegistryCredentialsBuiltinProps): React.JSX.Element | null {
  if (!config?.enabled || !config.host) return null;
  return (
    <div
      className={cn(
        'bg-accent/40 flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-3 transition-colors',
        hit && 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]',
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2">
          <span className="mono-data truncate text-sm">{config.host}</span>
          <Badge variant="muted">built-in</Badge>
        </p>
        <p className="text-muted-foreground text-xs">
          In your swarm · every server pulls over the private network, no credentials
        </p>
      </div>
      <StatusBadge tone={config.online ? 'online' : 'offline'} label={config.online ? 'Online' : 'Offline'} />
    </div>
  );
}
