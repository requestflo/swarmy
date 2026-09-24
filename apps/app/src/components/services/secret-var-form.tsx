import * as React from 'react';
import { Button, Input, Label, cn } from '@swarmy/ui';
import { SecretValueField } from '@/components/secretsmgr/secret-value-field';

export type SecretDelivery = 'env' | 'file';

interface SecretVarFormProps {
  /** Replace mode: the key is fixed and an empty value keeps the current one. */
  fixedKey?: string;
  initialDelivery?: SecretDelivery;
  pending?: boolean;
  onSubmit: (v: { key: string; value?: string; delivery: SecretDelivery }) => void;
  onCancel: () => void;
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Add or replace a secret variable: key, write-only value, delivery. */
export function SecretVarForm({ fixedKey, initialDelivery = 'env', pending, onSubmit, onCancel }: SecretVarFormProps): React.JSX.Element {
  const [key, setKey] = React.useState(fixedKey ?? '');
  const [value, setValue] = React.useState('');
  const [delivery, setDelivery] = React.useState<SecretDelivery>(initialDelivery);
  const keyOk = KEY_RE.test(key);
  const canSave = keyOk && (value.length > 0 || (fixedKey !== undefined && delivery !== initialDelivery));

  return (
    <form
      className="bg-muted/40 grid gap-3 rounded-xl p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSubmit({ key, value: value || undefined, delivery });
      }}
    >
      {!fixedKey && (
        <div className="grid gap-1.5">
          <Label className="mono-label">Name</Label>
          <Input
            autoFocus
            className="font-mono"
            placeholder="DATABASE_PASSWORD"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
          />
        </div>
      )}
      <SecretValueField value={value} onChange={setValue} label={fixedKey ? 'New value' : 'Value'} />
      <div className="grid gap-1.5">
        <Label className="mono-label">Delivered as</Label>
        <div className="flex flex-wrap gap-2">
          {(['env', 'file'] as const).map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant="outline"
              className={cn('rounded-full', delivery === d && 'border-primary text-primary')}
              onClick={() => setDelivery(d)}
            >
              {d === 'env' ? `$${key || 'NAME'}` : `${key || 'NAME'}_FILE`}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {delivery === 'env'
            ? 'Exported as an env var when the container starts — the value never appears in the service spec. Needs /bin/sh in the image.'
            : `Read from /run/secrets/${key || 'NAME'} (the _FILE convention official images support). Works on any image.`}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" className="rounded-full font-bold" disabled={!canSave || pending}>
          {fixedKey ? 'Save & roll out' : 'Add secret'}
        </Button>
      </div>
    </form>
  );
}
