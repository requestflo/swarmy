import * as React from 'react';
import { WandSparklesIcon } from 'lucide-react';
import { Button, Label, Textarea } from '@swarmy/ui';

/** 32 random bytes as base64url — a strong default for API keys/passwords. */
export function generateSecretValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The write-only value editor shared by create + rotate: multiline paste box
 * with a generate-random helper. The value goes straight to Docker — swarmy
 * never stores or shows it again.
 */
export function SecretValueField({
  value,
  onChange,
  label = 'Value',
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="mono-label">{label}</Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-primary h-7 gap-1 px-2 text-xs font-bold"
          onClick={() => onChange(generateSecretValue())}
        >
          <WandSparklesIcon className="size-3.5" /> Generate random
        </Button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        placeholder="Paste the secret value…"
        className="mono-data resize-y text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <p className="text-muted-foreground text-xs">
        Write-only: it goes straight into Docker and can never be read back here.
      </p>
    </div>
  );
}
