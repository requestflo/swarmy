import * as React from 'react';
import { LinkIcon, PencilIcon } from 'lucide-react';
import type { ConfigFamilyView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { AttachConfigInline } from './attach-config-inline';
import { ConfigDangerRow } from './config-danger-row';
import { ConfigEditorInline } from './config-editor-inline';
import { ConfigVersionsList } from './config-versions-list';
import { FamilyConsumers } from './family-consumers';
import { FamilyContent } from './family-content';

interface ConfigRowExpandProps {
  family: ConfigFamilyView;
  stack: string;
}

/**
 * The row-expand (replaces the old drawer): readable content with an inline
 * editor (diff-previewed edits), version history with apply/rollback, live
 * consumers with detach, inline attach and housekeeping — no overlays.
 */
export function ConfigRowExpand({ family, stack }: ConfigRowExpandProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);
  const [inspecting, setInspecting] = React.useState<number | undefined>(undefined);

  return (
    <div className="border-border space-y-5 border-t px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing((e) => !e)}
        >
          <PencilIcon className="size-3.5" /> {editing ? 'Close editor' : 'Edit'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAttaching((a) => !a)}>
          <LinkIcon className="size-3.5" /> {attaching ? 'Close attach' : 'Attach to service'}
        </Button>
        <span className="mono-data text-muted-foreground ml-auto hidden text-xs sm:block">
          {family.mountPath}
        </span>
      </div>

      <AttachConfigInline
        family={family}
        stack={stack}
        open={attaching}
        onDone={() => setAttaching(false)}
      />

      {editing ? (
        <ConfigEditorInline family={family} onDone={() => setEditing(false)} />
      ) : (
        <FamilyContent
          family={family.family}
          {...(inspecting !== undefined ? { version: inspecting } : {})}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <ConfigVersionsList family={family} inspecting={inspecting} onInspect={setInspecting} />
        <FamilyConsumers family={family} />
      </div>

      <ConfigDangerRow family={family} />
    </div>
  );
}
