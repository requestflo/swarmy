import * as React from 'react';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { CopyButton, cn } from '@swarmy/ui';
import type { StackAppMatch } from '@/components/gitops/gitops-types';
import { changedLines, composeOf } from './settings-compose';
import { applyDraft, type SettingsDraft } from './settings-model';

/** Where this setting lives, honestly: nothing here opens a PR. */
function sourceNote(git: StackAppMatch | null | undefined, serviceId: string): string {
  if (git) {
    return `Lives in ${git.app.configPath} (${git.app.fullName ?? git.app.url}). Applying here changes the running part now; the next deploy from git puts swarmy.yaml back.`;
  }
  return `Dashboard setting, applied to the live part. Copies are also POST /api/v1/services/${serviceId}/scale; the other settings have no REST route yet.`;
}

/**
 * The live compose for this part (Code depth): generated from the current
 * spec plus the draft, with the lines the draft changes highlighted.
 */
export function SettingsCode({
  short,
  serviceId,
  spec,
  draft,
  git,
  fill,
  className,
}: {
  short: string;
  serviceId: string;
  spec: ServiceSpec;
  draft: SettingsDraft;
  git: StackAppMatch | null | undefined;
  /** Grow with its container instead of capping at 640px (the panel's compose column). */
  fill?: boolean;
  className?: string;
}): React.JSX.Element {
  const base = React.useMemo(() => composeOf(short, spec), [short, spec]);
  const next = React.useMemo(() => composeOf(short, applyDraft(spec, draft)), [short, spec, draft]);
  const marked = React.useMemo(() => changedLines(base, next), [base, next]);
  const lines = next.split('\n');
  return (
    <section aria-label="Live spec as compose" className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">Compose · live spec</h3>
        {marked.size ? (
          <span className="text-tone-warn font-mono text-[11px]">
            {marked.size} changed · highlighted
          </span>
        ) : null}
        <CopyButton value={next} className="ml-auto size-8" />
      </div>
      <pre tabIndex={0} aria-label="compose code" className={cn('calm-code overflow-auto py-3 text-[12px] leading-[1.6]', !fill && 'max-h-[640px]')}>
        {lines.map((l, i) => (
          <span
            key={i}
            className={cn('block pr-4 pl-2 whitespace-pre', marked.has(i) && 'bg-tone-warn/15 border-tone-warn border-l-2 pl-1.5')}
          >
            <span aria-hidden className="text-muted-foreground/60 mr-3 inline-block w-5 text-right select-none">
              {i + 1}
            </span>
            {marked.has(i) ? <span className="sr-only">changed: </span> : null}
            {l}
          </span>
        ))}
      </pre>
      <p className="text-muted-foreground text-xs leading-relaxed">{sourceNote(git, serviceId)}</p>
    </section>
  );
}
