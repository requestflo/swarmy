import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import { TelemetryRedactionRule } from '@swarmy/core';

type Kind = TelemetryRedactionRule['kind'];
type Target = TelemetryRedactionRule['target'];

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'mask-regex', label: 'Mask text that matches' },
  { value: 'drop-attr', label: 'Drop a field by name' },
];
const TARGETS: Array<{ value: Target; label: string }> = [
  { value: 'both', label: 'Traces and logs' },
  { value: 'span', label: 'Traces' },
  { value: 'log', label: 'Logs' },
];

function slug(name: string, taken: readonly string[]): string {
  const base = `rule-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'custom'}`;
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

const selectCls = 'border-input bg-background h-9 rounded-md border px-2 text-sm pointer-coarse:min-h-11';

/** The inline "Add rule" form. Validated with the same schema the server uses. */
export function RedactionRuleForm({
  taken,
  onAdd,
  onCancel,
}: {
  taken: readonly string[];
  onAdd: (rule: TelemetryRedactionRule) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Kind>('mask-regex');
  const [target, setTarget] = React.useState<Target>('both');
  const [match, setMatch] = React.useState('');
  const [replace, setReplace] = React.useState('****');
  const [error, setError] = React.useState<string | null>(null);
  const ids = React.useId();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = TelemetryRedactionRule.safeParse({
      id: slug(name, taken),
      name,
      kind,
      target,
      match,
      ...(kind === 'mask-regex' ? { replace } : {}),
      enabled: true,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the rule');
    onAdd(parsed.data);
  };

  return (
    <form onSubmit={submit} className="border-border my-2 flex flex-col gap-3 rounded-xl border p-3" aria-label="New redaction rule">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Mask API keys" className="pointer-coarse:min-h-11" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-kind`}>What it does</Label>
          <select id={`${ids}-kind`} value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={selectCls}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-match`}>{kind === 'drop-attr' ? 'Field name (regex)' : 'Text to find (regex)'}</Label>
          <Input
            id={`${ids}-match`}
            value={match}
            onChange={(e) => setMatch(e.target.value)}
            placeholder={kind === 'drop-attr' ? '^http\\.request\\.header\\.x-api-key$' : 'sk_live_[A-Za-z0-9]+'}
            className="font-mono text-[12.5px] pointer-coarse:min-h-11"
          />
        </div>
        {kind === 'mask-regex' ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-replace`}>Replace with</Label>
            <Input id={`${ids}-replace`} value={replace} onChange={(e) => setReplace(e.target.value)} className="font-mono text-[12.5px] pointer-coarse:min-h-11" />
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${ids}-target`}>Applies to</Label>
          <select id={`${ids}-target`} value={target} onChange={(e) => setTarget(e.target.value as Target)} className={selectCls}>
            {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>
      {error ? <p className="text-tone-bad text-xs">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" className="pointer-coarse:min-h-11">Add to the list</Button>
        <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
