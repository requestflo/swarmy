import * as React from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { numberWord } from '@/components/apps/app-words';
import { MonoChip, SettingRow } from './settings-row';

/** Copies − n + — part of the draft, applied with `services.scale`. */
export function CopiesRow({
  running,
  desired,
  want,
  global,
  onChange,
}: {
  running: number;
  desired: number;
  want: number;
  global: boolean;
  onChange: (n: number) => void;
}): React.JSX.Element {
  const say = global
    ? 'One copy runs on every server.'
    : desired === 0
      ? 'Stopped on purpose: no copies running.'
      : running >= desired
        ? `${numberWord(desired)} ${desired === 1 ? 'copy is' : 'copies are'} running.`
        : `${running} of ${desired} copies are running.`;
  return (
    <SettingRow title="Copies">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px]">{say}</p>
        {global ? null : (
          <div role="group" aria-label="Copies" className="border-border flex items-center rounded-lg border">
            <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label="One fewer copy" disabled={want <= 0} onClick={() => onChange(want - 1)}>
              <MinusIcon className="size-4" />
            </Button>
            <output aria-live="polite" className="w-8 text-center font-mono text-sm">
              {want}
            </output>
            <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" aria-label="One more copy" disabled={want >= 50} onClick={() => onChange(want + 1)}>
              <PlusIcon className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <Tech>
        mode {global ? 'global' : 'replicated'} · replicas {running}/{desired}
      </Tech>
    </SettingRow>
  );
}

/** Labels as mono chips — technical, so from Controls up. */
export function LabelsRow({ labels }: { labels: Record<string, string> }): React.JSX.Element | null {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <SettingRow title="Labels" hint={`${entries.length}`}>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span key={k} title={v.length > 40 ? `${k}=${v}` : undefined}>
            <MonoChip>{v.length > 40 ? k : `${k}=${v}`}</MonoChip>
          </span>
        ))}
      </div>
    </SettingRow>
  );
}
