import * as React from 'react';
import { KeyRoundIcon } from 'lucide-react';
import type { SecretFamilyView } from '@swarmy/core';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
} from '@swarmy/ui';
import { relTime } from '@/lib/format';
import { AttachSecretDialog } from './attach-secret-dialog';
import { familyTone } from './families-table';
import { FamilyConsumers } from './family-consumers';
import { FamilyDanger } from './family-danger';
import { RotateSecretDialog } from './rotate-secret-dialog';

/**
 * Family detail: version history, live consumers (with links + detach),
 * rotate/attach actions and the housekeeping/danger zone.
 */
export function FamilyDrawer({
  family,
  onOpenChange,
}: {
  family: SecretFamilyView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const tone = family ? familyTone(family) : null;

  return (
    <Sheet open={family !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b p-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <KeyRoundIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="mono-data truncate">{family?.family ?? 'Secret'}</SheetTitle>
              <SheetDescription className="mono-label !mb-0">
                {family ? `v${family.currentVersion} · rotated ${relTime(family.lastRotatedAt)}` : '…'}
              </SheetDescription>
            </div>
            {tone ? (
              <StatusBadge tone={tone.tone} label={tone.label} className="ml-auto shrink-0" />
            ) : null}
          </div>
        </SheetHeader>

        {!family ? null : (
          <div className="space-y-6 p-6">
            <div className="flex flex-wrap items-center gap-2">
              <RotateSecretDialog family={family} />
              <AttachSecretDialog family={family} />
            </div>

            <FamilyConsumers family={family} />

            <section className="space-y-2">
              <p className="mono-label text-muted-foreground !mb-0">Versions</p>
              <div className="divide-border border-border divide-y rounded-xl border">
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

            <FamilyDanger family={family} onDeleted={() => onOpenChange(false)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
