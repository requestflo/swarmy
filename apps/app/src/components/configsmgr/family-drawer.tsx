import * as React from 'react';
import { FileCogIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  StatusBadge,
} from '@swarmy/ui';
import { relTime } from '@/lib/format';
import { AttachConfigDialog } from './attach-config-dialog';
import { EditConfigDialog } from './edit-config-dialog';
import { familyTone } from './families-table';
import { FamilyConsumers } from './family-consumers';
import { FamilyContent } from './family-content';
import { FamilyDanger } from './family-danger';
import { FamilyVersions } from './family-versions';

/**
 * Family detail: content preview, edit (new version + diff), version history
 * with rollback, live consumers, attach and the housekeeping/danger zone.
 */
export function FamilyDrawer({
  family,
  onOpenChange,
}: {
  family: ConfigFamilyView | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const tone = family ? familyTone(family) : null;
  const [inspecting, setInspecting] = React.useState<number | undefined>(undefined);

  // Reset the inspected version whenever a different family is opened.
  const key = family?.family;
  React.useEffect(() => setInspecting(undefined), [key]);

  return (
    <Sheet open={family !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b p-6">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
              <FileCogIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="mono-data truncate">{family?.family ?? 'Config'}</SheetTitle>
              <SheetDescription className="mono-label !mb-0">
                {family
                  ? `v${family.currentVersion} · updated ${relTime(family.lastUpdatedAt)}`
                  : '…'}
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
              <EditConfigDialog family={family} />
              <AttachConfigDialog family={family} />
            </div>

            <FamilyContent
              family={family.family}
              {...(inspecting !== undefined ? { version: inspecting } : {})}
            />

            <FamilyVersions family={family} inspecting={inspecting} onInspect={setInspecting} />

            <FamilyConsumers family={family} />

            <FamilyDanger family={family} onDeleted={() => onOpenChange(false)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
