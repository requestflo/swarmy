import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import type { PrivateNetwork } from './use-private-network';

const PHRASE = 'turn off';

const list = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Picking None on a live private network: what drops off (the servers behind
 * NAT can't be reached any other way), then an admin types the phrase. It
 * turns the network off first — the controller refuses that while a server
 * runs the swarm over it — and only then sets the driver to none.
 */
export function TurnOffMesh({
  n,
  natNames,
  isAdmin,
  onCancel,
}: {
  n: PrivateNetwork;
  natNames: string[];
  isAdmin: boolean;
  onCancel: () => void;
}): React.JSX.Element {
  const [typed, setTyped] = React.useState('');
  const busy = n.setEnabled.isPending || n.setDriver.isPending;
  const confirm = async (): Promise<void> => {
    try {
      await n.setEnabled.mutateAsync({ enabled: false });
      await n.setDriver.mutateAsync({ driver: 'none' });
      onCancel();
    } catch {
      // the mutation's onError toasts the controller's reason
    }
  };
  return (
    <div role="group" aria-label="Turn the private network off" className="border-tone-warn/40 bg-tone-warn/5 flex flex-col gap-3 rounded-xl border px-4 py-3.5">
      <p className="text-tone-warn text-[13px] leading-relaxed">
        {natNames.length
          ? `${list(natNames)} ${natNames.length === 1 ? 'is' : 'are'} behind NAT and would drop off. `
          : 'Servers would talk over their own network; anything that only reaches them privately stops. '}
        Turning the private network off needs an admin and a typed confirm.
      </p>
      {isAdmin ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mesh-off-phrase">
              Type <span className="font-mono">{PHRASE}</span> to confirm
            </Label>
            <Input
              id="mesh-off-phrase"
              autoComplete="off"
              className="max-w-xs font-mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" disabled={typed.trim().toLowerCase() !== PHRASE || busy} onClick={() => void confirm()} className="pointer-coarse:min-h-11">
              {busy ? 'Turning off…' : 'Turn it off'}
            </Button>
            <Button variant="ghost" onClick={onCancel} className="pointer-coarse:min-h-11">
              Keep it on
            </Button>
          </div>
        </>
      ) : (
        <Button variant="ghost" onClick={onCancel} className="w-fit pointer-coarse:min-h-11">
          Keep it on
        </Button>
      )}
      <Tech>mesh.setEnabled(false) → mesh.setDriver(none) · refused while a server runs the swarm over the mesh</Tech>
    </div>
  );
}
