import * as React from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Button, CopyButton } from '@swarmy/ui';
import { Section } from '@/components/calm';
import { revealRow } from './secret-reveal';

function SecretRow({ note }: { note: string }): React.JSX.Element {
  const row = revealRow(note);
  const [shown, setShown] = React.useState(false);
  return (
    <li className="border-border flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t py-2.5 first:border-t-0 first:pt-0">
      <span className="min-w-0 flex-1 text-[13.5px] font-semibold">{row.label}</span>
      <span className="mono-data flex min-w-0 items-center gap-1 text-[12.5px] break-all">
        {row.login ? <span className="text-muted-foreground">{row.login} /</span> : null}
        <span aria-label={shown ? undefined : 'hidden'}>{shown ? row.secret : '•'.repeat(Math.min(16, Math.max(8, row.secret.length)))}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={shown ? `Hide ${row.label}` : `Show ${row.label}`}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
        <CopyButton value={row.secret} label="Copy" className="pointer-coarse:min-h-11" />
      </span>
    </li>
  );
}

/**
 * One-time secrets from a deploy (a generated admin login): one row each,
 * masked until you show it, with Copy. Shown once, inline, never in a modal,
 * and never retrievable again. Plain after-deploy steps are not secrets and
 * live in "After it's live"; with no secret there is no banner at all.
 */
export function DeploySecretsBanner({ notes }: { notes: string[] }): React.JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <Section title="Save these now · shown once" hint="swarmy doesn’t keep a copy" className="border-status-warning/50 border">
      <ul className="flex flex-col">
        {notes.map((note) => (
          <SecretRow key={note} note={note} />
        ))}
      </ul>
    </Section>
  );
}
