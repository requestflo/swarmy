import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import type { PlatformAvailable } from './use-platform';

const KIND: Record<string, string> = { new: 'New', better: 'Better', fix: 'Fixed', security: 'Security', breaking: 'Needs you' };

/** What changes in the next version, one line each. */
export function ReleaseNotes({ av }: { av: PlatformAvailable }): React.JSX.Element {
  return (
    <Section title={`What changes in ${av.version}`} count={av.notes.length} flush>
      <ul className="flex flex-col">
        {av.notes.map((n, i) => (
          <li key={i} className="border-border flex items-start gap-3 border-b py-2.5 last:border-b-0">
            <span className={`w-20 shrink-0 text-xs font-semibold ${n.kind === 'breaking' ? 'text-tone-bad' : n.kind === 'security' ? 'text-tone-warn' : 'text-muted-foreground'}`}>{KIND[n.kind] ?? n.kind}</span>
            <span className="text-[13.5px] leading-snug">{n.text}</span>
          </li>
        ))}
      </ul>
      <Tech>{`${av.verified ? 'signed · verified against the swarmy release key' : 'UNVERIFIED release'}${av.components.some((c) => c.changed) ? ` · changes ${av.components.filter((c) => c.changed).map((c) => c.key).join(', ')}` : ''}`}</Tech>
    </Section>
  );
}
