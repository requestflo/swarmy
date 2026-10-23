import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SERVICE_ENV_KEY, type InvService } from '@swarmy/core';
import { Button, Input } from '@swarmy/ui';
import { Segmented } from '@/components/service-settings/settings-row';
import type { RevealedSecret } from '@/components/secretsmgr/secret-reveal-banner';
import { useTRPC } from '@/integrations/trpc';
import { shortName } from '../use-stack-services';
import { useAddVariable, type AddKind } from './use-add-variable';

const KINDS: { value: AddKind; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'secret', label: 'Secret' },
  { value: 'ref', label: 'Reference' },
];
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const sel = 'border-border bg-background h-9 rounded-[8px] border px-2 font-mono text-xs pointer-coarse:min-h-11';

const HINT: Record<AddKind, (svc: string) => string> = {
  plain: (s) => `Plain text, set on ${s} now. It restarts one copy at a time.`,
  secret: (s) => `Stored as a Docker secret and mounted into ${s} at /run/secrets/<name>. Nobody can read it back.`,
  ref: (s) => `Points ${s} at a database or cache. swarmy fills it in, so the password never leaves the swarm.`,
};

/** Add Plain / Secret / Reference onto one service of the app. */
export function AddVariableBar({
  stack,
  services,
  scopeId,
  preset,
  onSecret,
}: {
  stack: string;
  services: InvService[];
  scopeId: string | null;
  /** Prefill from the page's next action ("keep it as a secret"). */
  preset?: { kind: AddKind; key: string; n: number };
  onSecret: (r: RevealedSecret) => void;
}): React.JSX.Element | null {
  const trpc = useTRPC();
  const [kind, setKind] = React.useState<AddKind>('plain');
  const [key, setKey] = React.useState('');
  const [value, setValue] = React.useState('');
  const [svcId, setSvcId] = React.useState<string | null>(null);
  const [res, setRes] = React.useState('');
  React.useEffect(() => {
    if (!preset) return;
    setKind(preset.kind);
    setKey(preset.key);
  }, [preset]);
  const endpoints = useQuery({ ...trpc.stacks.endpoints.queryOptions({ stack }), enabled: kind === 'ref' });
  const resources = [...new Map((endpoints.data?.resources ?? []).filter((r) => r.kind === 'postgres' || r.kind === 'cache').map((r) => [r.name, r])).values()];
  const { add, pending } = useAddVariable(stack, onSecret);

  const svc = services.find((s) => s.id === (svcId ?? scopeId)) ?? services[0];
  if (!svc) return null;
  const short = shortName(stack, svc.name);
  const resource = resources.find((r) => r.name === res) ?? resources[0];
  const nameOk = kind === 'secret' ? FAMILY.test(key) && key.length <= 56 : SERVICE_ENV_KEY.test(key);
  const ready = nameOk && (kind === 'ref' ? !!resource : value.length > 0) && !pending;
  const submit = async (): Promise<void> => {
    const ok = await add({
      kind,
      key,
      value,
      service: { id: svc.id, name: svc.name, short },
      ...(kind === 'ref' && resource ? { resource: { kind: resource.kind as 'postgres' | 'cache', name: resource.name } } : {}),
    });
    if (ok) {
      setKey('');
      setValue('');
    }
  };

  return (
    <div id="add-variable" className="border-border flex flex-col gap-2 border-t py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Add</span>
        <Input aria-label="Variable name" value={key} onChange={(e) => setKey(e.target.value)} placeholder={kind === 'ref' ? 'DATABASE_URL' : 'MAX_CART_ITEMS'} className="h-9 w-40 font-mono text-[12.5px]" spellCheck={false} autoComplete="off" />
        <Segmented label="Kind" options={KINDS} value={kind} onChange={setKind} />
        {kind === 'ref' ? (
          <select aria-label="Resource" value={resource?.name ?? ''} onChange={(e) => setRes(e.target.value)} className={`${sel} min-w-28 flex-1`}>
            {resources.length === 0 ? <option value="">{endpoints.isPending ? 'Reading…' : 'No database or cache in this app'}</option> : null}
            {resources.map((r) => (
              <option key={r.name} value={r.name}>{`${r.name} · ${r.kind === 'cache' ? 'cache' : 'postgres'}`}</option>
            ))}
          </select>
        ) : (
          <Input aria-label="Value" type={kind === 'secret' ? 'password' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" className="h-9 min-w-28 flex-1 font-mono text-[12.5px]" spellCheck={false} autoComplete="off" />
        )}
        <select aria-label="Service" value={svc.id} onChange={(e) => setSvcId(e.target.value)} className={sel}>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{shortName(stack, s.name)}</option>
          ))}
        </select>
        <Button variant="outline" size="sm" className="h-9 pointer-coarse:min-h-11" disabled={!ready} onClick={() => void submit()}>
          {pending ? 'Adding…' : `Add to ${short}`}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{HINT[kind](short)}</p>
    </div>
  );
}
