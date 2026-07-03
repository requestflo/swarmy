import * as React from 'react';
import type { ConfigFamilyView } from '@swarmy/core';
import { StatusBadge } from '@swarmy/ui';
import { relTime } from '@/lib/format';
import { ApplyConfigAlert } from './apply-config-alert';

interface ConfigVersionsListProps {
  family: ConfigFamilyView;
  /** Version currently shown in the content preview (undefined = current). */
  inspecting?: number;
  onInspect: (version: number | undefined) => void;
}

/**
 * Version history, newest first: click a row to inspect its content, apply
 * the current version to stale consumers, or roll back to an older one.
 */
export function ConfigVersionsList({
  family,
  inspecting,
  onInspect,
}: ConfigVersionsListProps): React.JSX.Element {
  const anyStale = family.staleConsumers > 0;
  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">Versions</p>
      <div className="divide-border border-border bg-card divide-y rounded-xl border">
        {family.versions.map((v) => (
          <div key={v.version} className="flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              title={`Show v${v.version} content`}
              onClick={() => onInspect(inspecting === v.version ? undefined : v.version)}
            >
              <p className="mono-data text-sm font-semibold">
                v{v.version}
                {inspecting === v.version ? (
                  <span className="text-primary ml-1.5 text-[10px] font-bold uppercase">
                    viewing
                  </span>
                ) : null}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {relTime(v.createdAt)}
                {v.consumers.length > 0 ? ` · ${v.consumers.join(', ')}` : ''}
              </p>
            </button>
            {v.current ? (
              anyStale ? (
                <ApplyConfigAlert family={family} version={v.version} trigger={`Apply v${v.version}`} />
              ) : (
                <StatusBadge tone="online" label="current" />
              )
            ) : (
              <ApplyConfigAlert family={family} version={v.version} trigger="Roll back" />
            )}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Rolling back is just applying an older version — same mount path, previous content.
      </p>
    </section>
  );
}
