import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { ServiceDetail } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { Tech } from '@/components/calm';
import { MonoChip, SettingRow } from './settings-row';

export function CommandRow({ spec }: { spec: ServiceSpec }): React.JSX.Element {
  const cmd = spec.command ?? [];
  const args = spec.args ?? [];
  return (
    <SettingRow title="Command">
      {cmd.length || args.length ? (
        <>
          <p className="text-[13.5px]">
            Starts with <span className="font-mono text-[12.5px] break-all">{[...cmd, ...args].join(' ')}</span>
          </p>
          <Tech>
            command: {cmd.length ? JSON.stringify(cmd) : '(image default)'} · args: {args.length ? JSON.stringify(args) : '—'}
          </Tech>
        </>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">Starts the way its image says to.</p>
      )}
    </SettingRow>
  );
}

/** Internal ports plus "reached via <domain>" from the app's front-door routes. */
export function PortsRow({
  ports,
  hosts,
  stack,
}: {
  ports: ServiceDetail['ports'];
  hosts: string[] | undefined;
  stack: string | null;
}): React.JSX.Element {
  const published = ports.filter((p) => p.published !== undefined);
  return (
    <SettingRow title="Ports">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {ports.map((p) => (
          <MonoChip key={`${p.target}-${p.protocol}`}>
            {p.target}
            {p.published !== undefined ? ` → ${p.published}` : ' · internal'}
          </MonoChip>
        ))}
        <p className="text-muted-foreground min-w-0 text-[13px]">
          {published.length
            ? 'Open on every server at the published port'
            : ports.length || hosts?.length
              ? 'No public port'
              : 'Only the other parts of this app talk to it'}
          {hosts === undefined ? null : hosts.length ? (
            <>
              {' '}
              — reached via{' '}
              {hosts.map((h, i) => (
                <React.Fragment key={h}>
                  {i ? ', ' : null}
                  <a className="text-primary font-mono underline-offset-2 hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center" href={`https://${h}`} target="_blank" rel="noreferrer">
                    {h}
                  </a>
                </React.Fragment>
              ))}
            </>
          ) : stack ? (
            <>
              {' '}
              —{' '}
              <Link to="/stacks/$name/network" params={{ name: stack }} className="text-primary hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                add an address
              </Link>
            </>
          ) : null}
        </p>
      </div>
      {ports.length ? <Tech>{ports.map((p) => `${p.target}/${p.protocol}${p.published !== undefined ? ` published ${p.published} (${p.mode})` : ''}`).join(' · ')}</Tech> : null}
    </SettingRow>
  );
}
