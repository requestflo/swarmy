import * as React from 'react';
import { LinkIcon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import { Button, StatusBadge } from '@swarmy/ui';
import { relTime } from '@/lib/format';
import { AttachSecretInline } from './attach-secret-inline';
import { FamilyConsumers } from './family-consumers';
import { RotateSecretAlert } from './rotate-secret-alert';
import { SecretDangerRow } from './secret-danger-row';

/** Version history, newest first — who is pinned where. */
function VersionsList({ family }: { family: SecretFamilyView }): React.JSX.Element {
  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Versions</p>
      <div className="divide-border border-border bg-card divide-y rounded-xl border">
        {family.versions.map((v) => (
          <div key={v.version} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="mono-data text-sm font-semibold">v{v.version}</p>
              <p className="text-muted-foreground truncate text-xs">
                {relTime(v.createdAt)}
                {v.consumers.length > 0 ? ` · ${v.consumers.join(', ')}` : ''}
              </p>
            </div>
            {v.current ? (
              <StatusBadge tone="online" label="current" />
            ) : v.consumers.length > 0 ? (
              <StatusBadge tone="warning" label="in use" />
            ) : (
              <StatusBadge tone="neutral" label="detached" />
            )}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Values are write-only — swarmy can rotate and remount them, never read them.
      </p>
    </section>
  );
}

interface SecretRowExpandProps {
  family: SecretFamilyView;
  stack: string;
}

/**
 * The row-expand (replaces the old drawer): rotate + inline attach, live
 * consumers with detach, version history and housekeeping — no overlays.
 */
export function SecretRowExpand({ family, stack }: SecretRowExpandProps): React.JSX.Element {
  const [attaching, setAttaching] = React.useState(false);

  return (
    <div className="border-border space-y-5 border-t px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <RotateSecretAlert family={family} />
        <Button size="sm" variant="outline" onClick={() => setAttaching((a) => !a)}>
          <LinkIcon className="size-3.5" /> {attaching ? 'Close attach' : 'Attach to service'}
        </Button>
        <span className="mono-data text-muted-foreground ml-auto hidden text-xs sm:block">
          /run/secrets/{family.family}
        </span>
      </div>

      <AttachSecretInline
        family={family}
        stack={stack}
        open={attaching}
        onDone={() => setAttaching(false)}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <FamilyConsumers family={family} />
        <VersionsList family={family} />
      </div>

      <SecretDangerRow family={family} />
    </div>
  );
}
