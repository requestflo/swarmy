import * as React from 'react';
import { cn } from '@swarmy/ui';
import { Depth, Section, Tech } from '@/components/calm';
import type { MeshDriverId } from './mesh-format';
import { TurnOffMesh } from './turn-off-mesh';
import type { PrivateNetwork } from './use-private-network';

function Pick({ on, title, sub, onClick, disabled }: { on: boolean; title: string; sub: string; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-14 flex-1 flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed',
        on ? 'border-primary/70 bg-accent/60 shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_12%,transparent)]' : 'border-border hover:border-foreground/25 disabled:opacity-60',
      )}
    >
      <b className="text-[13.5px] font-semibold">{title}</b>
      <span className="text-muted-foreground text-xs">{sub}</span>
    </button>
  );
}

/**
 * Board 43's "Private network" card: NetBird or None (Headscale at
 * Controls), on/off, where the control plane is, and how new servers join.
 * None on a live network goes through the typed confirm; only admins change it.
 */
export function MeshDriverPick({ n, isAdmin, natNames }: { n: PrivateNetwork; isAdmin: boolean; natNames: string[] }): React.JSX.Element {
  const [confirming, setConfirming] = React.useState(false);
  const busy = n.setDriver.isPending || n.setEnabled.isPending;
  const turnOn = async (driver: MeshDriverId): Promise<void> => {
    setConfirming(false);
    try {
      if (n.driver !== driver) await n.setDriver.mutateAsync({ driver });
      if (!n.config?.enabled) await n.setEnabled.mutateAsync({ enabled: true });
    } catch {
      // the mutation's onError toasts it
    }
  };
  const off = !isAdmin || busy;
  return (
    <Section
      title="Private network"
      action={
        <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', n.live ? 'bg-tone-ok/15 text-tone-ok' : 'bg-muted text-muted-foreground')}>
          {n.live ? 'On · no inbound ports' : 'Off'}
        </span>
      }
    >
      <div role="radiogroup" aria-label="Private network" className="flex flex-col gap-2 sm:flex-row">
        <Pick on={n.live && n.driver === 'netbird' && !confirming} title="NetBird" sub="recommended · works behind NAT" disabled={off} onClick={() => void turnOn('netbird')} />
        <Pick
          on={!n.live || confirming}
          title="None"
          sub="servers use their own network · swarmy adds nothing"
          disabled={off}
          onClick={() => (n.live ? setConfirming(true) : n.driver !== 'none' ? n.setDriver.mutate({ driver: 'none' }) : undefined)}
        />
      </div>
      {confirming && n.live ? <TurnOffMesh n={n} natNames={natNames} isAdmin={isAdmin} onCancel={() => setConfirming(false)} /> : null}
      <Depth at="controls">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Other driver:</span>
          <button
            type="button"
            role="radio"
            aria-checked={n.live && n.driver === 'headscale'}
            disabled={off || (n.live && n.driver !== 'headscale')}
            onClick={() => void turnOn('headscale')}
            className={cn('rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-60 pointer-coarse:min-h-11', n.live && n.driver === 'headscale' ? 'border-primary/70' : 'border-border')}
          >
            Headscale (advanced)
          </button>
          <span className="text-muted-foreground text-xs">your own Headscale server, official clients{n.live && n.driver !== 'headscale' ? ' · turn the network off first' : ''}</span>
        </div>
      </Depth>
      {!isAdmin ? <p className="text-muted-foreground text-xs">Only an admin can change this.</p> : null}
      {n.live ? (
        <dl className="border-border grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-x-3 gap-y-2 border-t pt-3 text-[13px]">
          <dt className="text-muted-foreground">Run by</dt>
          <dd>{n.managed ? 'swarmy, on your own servers' : 'your own server'}</dd>
          <dt className="text-muted-foreground">New servers</dt>
          <dd>join it on their own when you add them · with a single-use key</dd>
        </dl>
      ) : null}
      <Tech>{`driver ${n.driver} · enabled ${!!n.config?.enabled} · control plane ${n.config?.controlPlaneMode ?? '—'}${n.config?.managementUrl ? ` · ${n.config.managementUrl}` : ''}`}</Tech>
    </Section>
  );
}
