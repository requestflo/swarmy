import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { LockIcon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Input, Switch } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { PrivateHostNote } from '@/components/ingress/private-host-note';
import { getsAutoAddress } from '@/components/blueprints/template-words';
import { ConfigureField } from './configure-field';
import type { ConfigureFormState } from './use-configure-form';

function HttpsChip(): React.JSX.Element {
  return (
    <span className="bg-status-online/12 text-tone-ok inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-semibold">
      <LockIcon aria-hidden className="size-3" /> HTTPS
    </span>
  );
}

/** App name and web address (the automatic one, or your own domain behind a switch). */
export function ConfigureIdentity({
  meta,
  form,
  autoHost,
  planPending,
}: {
  meta: BlueprintMetaView;
  form: ConfigureFormState;
  autoHost: string | null | undefined;
  planPending: boolean;
}): React.JSX.Element {
  const auto = getsAutoAddress(meta);
  return (
    <>
      <ConfigureField label="App name" htmlFor="cfg-name" help="Used in addresses and logs. Lowercase, no spaces." error={form.nameError}>
        <Input id="cfg-name" value={form.name} onChange={(e) => form.setName(e.target.value.toLowerCase())} className="h-11 font-mono" autoComplete="off" spellCheck={false} />
      </ConfigureField>
      {meta.supportsDomain ? (
        <ConfigureField label="Web address" htmlFor={form.ownDomain ? 'cfg-domain' : undefined} error={form.domainError}>
          {form.ownDomain ? (
            <div className="flex items-center gap-2">
              <Input id="cfg-domain" value={form.domain} onChange={(e) => form.setDomain(e.target.value)} placeholder="blog.example.com" className="h-11 font-mono" autoComplete="off" spellCheck={false} />
              <HttpsChip />
            </div>
          ) : auto ? (
            <div className="flex items-center gap-2">
              <div className="border-border bg-muted/40 flex h-11 min-w-0 flex-1 items-center rounded-md border px-3 font-mono text-[13.5px]">
                {autoHost ? <span className="truncate">{autoHost}</span> : planPending ? <span className="shimmer-line h-4 w-3/4 rounded" /> : <span className="text-muted-foreground truncate font-sans">A web address with HTTPS is made for you</span>}
              </div>
              <HttpsChip />
            </div>
          ) : (
            <p className="text-muted-foreground text-[13px]">No web address unless you add your own domain.</p>
          )}
          <label className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <Switch checked={form.ownDomain} onCheckedChange={form.setOwnDomain} />
            <span className="text-[13px]">Use my own domain</span>
            <span className="text-muted-foreground text-xs">
              {form.ownDomain ? (
                <Link to="/network" className="text-primary hover:underline">DNS help →</Link>
              ) : auto ? (
                'Works now, no DNS needed. Switch any time.'
              ) : (
                'Add one now or any time later.'
              )}
            </span>
          </label>
          {form.ownDomain ? <PrivateHostNote host={form.domain} /> : null}
          <Tech>{form.ownDomain ? 'ingress.route · certificate issued for you' : auto ? 'swarmy.ingress.auto · {service}-{app}.{zone, or edge-ip.sslip.io}' : 'no route until a domain is set'}</Tech>
        </ConfigureField>
      ) : (
        <ConfigureField label="Web address">
          <p className="text-muted-foreground text-[13px]">Private: only your other apps can reach it.</p>
        </ConfigureField>
      )}
    </>
  );
}
