import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { NextAction } from '@/components/calm';
import { PassphraseCard } from '@/components/controllerbackup/passphrase-card';
import { RunStatus } from './run-status';
import { UpgradeDialog } from './upgrade-dialog';
import { upgradePrereq } from './platform-words';
import type { PlatformStatus } from './use-platform';

/**
 * The page's one next action: a live or failed run; else, when a version is
 * ready, whatever has to happen first (a backup passphrase — preflight backs
 * swarmy up and refuses without one); else Upgrade.
 */
export function UpgradeNext({ v, admin }: { v: PlatformStatus; admin: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const av = v.release.available;
  const run = v.run;
  const backup = useQuery({ ...trpc.controllerBackup.getConfig.queryOptions(), enabled: admin && !!av });
  const [setting, setSetting] = React.useState(false);

  if (run && (run.status === 'running' || run.status === 'failed')) return <RunStatus run={run} admin={admin} />;
  if (!av || !admin) return null;

  if (upgradePrereq(backup.data) === 'passphrase') {
    return (
      <NextAction
        tone="warn"
        eyebrow="Before you upgrade"
        title="Set a backup passphrase first."
        tech="preflight takes a controller backup · controllerBackup.setPassphrase · Backups → swarmy itself"
        actions={
          setting ? undefined : (
            <Button onClick={() => setSetting(true)} className="pointer-coarse:min-h-11">
              Set a backup passphrase
            </Button>
          )
        }
        hint={setting ? undefined : `Then Upgrade to ${av.version} appears here.`}
      >
        swarmy saves a copy of itself before every upgrade, locked with a passphrase only you keep. There isn’t one yet, so the
        upgrade would stop at its first step. Make one, store it somewhere safe, and the upgrade to {av.version} is next.
        {setting ? (
          <div className="mt-3">
            <PassphraseCard />
          </div>
        ) : null}
      </NextAction>
    );
  }

  return (
    <NextAction
      tone="info"
      title={`${av.version} is ready to install.`}
      tech={`${v.release.current.version} → ${av.version} · ${av.verified ? 'signed, verified' : 'unverified'}`}
      actions={<UpgradeDialog av={av} />}
      hint={av.blocked ?? (av.migrations.some((m) => m.pause) ? 'Includes a brief pause for object storage.' : 'Rolling: apps keep serving.')}
    >
      Backed up first, one piece at a time, each put back on its own if it doesn’t come up healthy.
    </NextAction>
  );
}
