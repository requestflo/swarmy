import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { ALWAYS_BLOCK, MASK_TEXT, masked, recorderView, type PreviewField } from './recorder-preview-model';
import { Chip, RumSection, Segmented } from './rum-ui';
import type { RumSettings } from './rum-shared';

type View = 'masked' | 'unmasked';
const VIEWS: { value: View; label: string }[] = [
  { value: 'masked', label: 'masked' },
  { value: 'unmasked', label: 'unmasked' },
];

/**
 * An example checkout form drawn twice: as the visitor sees it, and as a
 * replay stores it under this app's masking settings — inputs always masked,
 * sensitive or (when on) all text masked, never-record selectors and iframes
 * blocked to a grey box. Follows the Masking card live.
 */
export function RecorderPreview({ settings: s }: { settings: RumSettings }): React.JSX.Element {
  const [view, setView] = React.useState<View>('masked');
  const fields = React.useMemo(
    () => recorderView({ maskAllText: s.maskAllText, blockSelectors: s.blockSelectors }, document),
    [s.maskAllText, s.blockSelectors],
  );
  const raw = view === 'unmasked';

  return (
    <RumSection
      title="What the recorder sees"
      badge={<Chip>example form</Chip>}
      action={<Segmented label="Preview" value={view} options={VIEWS} onChange={setView} />}
    >
      <div aria-label="Example checkout form as recorded" className="bg-muted/40 flex flex-col gap-2 rounded-xl border p-3">
        {fields.map((f) => (
          <Field key={f.key} f={f} raw={raw} />
        ))}
      </div>
      <p className={cn('text-xs', raw ? 'text-tone-warn' : 'text-muted-foreground')}>
        {raw
          ? 'What the visitor sees. The dotted and grey parts of the masked view never reach a replay — typed values are always masked.'
          : 'An example form, not your app — drawn with this app’s masking rules.'}
      </p>
      <Tech>
        maskAllInputs · maskTextSelector {s.maskAllText ? '*' : MASK_TEXT} · blockSelector{' '}
        {[...new Set([...s.blockSelectors, ...ALWAYS_BLOCK])].join(',')}
      </Tech>
    </RumSection>
  );
}

function Field({ f, raw }: { f: PreviewField; raw: boolean }): React.JSX.Element {
  const shown = raw || f.state === 'clear' ? f.value : masked(f);
  const blocked = !raw && f.state === 'blocked';
  const body = blocked ? (
    <span className="bg-muted-foreground/25 text-muted-foreground flex h-8 items-center rounded-md px-2 font-mono text-[11px]">
      blocked · grey box
    </span>
  ) : f.kind === 'input' || f.kind === 'frame' ? (
    <span className="bg-card flex h-8 items-center truncate rounded-md border px-2 font-mono text-xs">{shown}</span>
  ) : f.kind === 'button' ? (
    <span className="bg-ink text-ink-foreground w-fit rounded-full px-3 py-1 text-xs font-semibold">{shown}</span>
  ) : (
    <span className={cn('truncate', f.kind === 'title' ? 'text-sm font-bold' : 'text-xs')}>{shown}</span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {f.label ? <span className="text-muted-foreground font-mono text-[10.5px]">{f.label}</span> : null}
      {body}
    </div>
  );
}
