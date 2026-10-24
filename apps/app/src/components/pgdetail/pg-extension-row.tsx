import * as React from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Switch } from '@swarmy/ui';
import { Tech } from '@/components/calm';

export interface PgExtensionRowProps {
  name: string;
  sentence: string;
  tech: string;
  checked: boolean;
  disabled: boolean;
  busy?: boolean;
  onChange: (on: boolean) => void;
}

/** One extension: mono name · the sentence · its switch; the tech line at Controls. */
export function PgExtensionRow({ name, sentence, tech, checked, disabled, busy, onChange }: PgExtensionRowProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {/* Phone: name + switch, the sentence under them. sm+: name · sentence · switch. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
        <span className="font-mono text-[13px] font-semibold break-all">{name}</span>
        <span className="text-muted-foreground order-3 col-span-2 text-[13px] leading-snug sm:order-none sm:col-span-1" aria-live={busy ? 'polite' : undefined}>
          {busy ? <LoaderCircleIcon aria-hidden className="text-tone-info mr-1 inline size-3.5 animate-spin motion-reduce:animate-none" /> : null}
          {sentence}
        </span>
        <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={name} className="pointer-coarse:min-h-11" />
      </div>
      <Tech className="sm:pl-[9.75rem]">{tech}</Tech>
    </div>
  );
}
