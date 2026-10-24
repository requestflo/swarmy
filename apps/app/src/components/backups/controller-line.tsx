import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { TONE_DOT, TONE_TEXT, Tech } from '@/components/calm';
import { storeWords } from '@/components/controllerbackup/store-words';
import { useTRPC } from '@/integrations/trpc';
import { fmtBytes, relativeTime } from './backup-format';

/**
 * "swarmy itself" in one line: when swarmy's own state was last backed up,
 * how big, and where (`controllerBackup.getConfig` + `listSnapshots`), and
 * whether its live store is copied off this server with the measured lag
 * (`controllerStore.status`). The full controls are the "swarmy itself"
 * section further down.
 */
export function ControllerLine(): React.JSX.Element | null {
  const trpc = useTRPC();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const snaps = useQuery({ ...trpc.controllerBackup.listSnapshots.queryOptions(), refetchInterval: 30_000 });
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const store = useQuery({ ...trpc.controllerStore.status.queryOptions(), refetchInterval: 10_000 });
  if (!config.data || !snaps.data) return null;
  const live = store.data ? storeWords(store.data) : null;
  const last = snaps.data.find((s) => s.status === 'SUCCEEDED') ?? null;
  const where = targets.data?.find((t) => t.id === (last?.targetId ?? config.data.targetId))?.name ?? null;
  const ok = !!last && config.data.enabled && config.data.hasPassphrase;
  const time = last ? new Date(last.startedAt).toISOString().slice(11, 16) : null;
  return (
    <a href="#swarmy-itself" className="calm-card hover:bg-foreground/[0.02] flex flex-col gap-1 px-5 py-4">
      <span className="calm-eyebrow">swarmy itself</span>
      <span className="flex items-center gap-2 text-[14px] font-semibold">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[ok ? 'ok' : 'warn'])} />
        {last ? `Backed up ${relativeTime(last.startedAt)}` : config.data.enabled ? 'Not backed up yet' : 'Not set up yet'}
      </span>
      <span className="text-muted-foreground font-mono text-[11.5px]">
        {[last?.sizeBytes ? fmtBytes(last.sizeBytes) : null, 'settings, people, history', where ? `to ${where}` : null].filter(Boolean).join(' · ')}
      </span>
      {!config.data.hasPassphrase ? <span className="text-tone-warn text-[13px]">Needs a restore passphrase before it can be rebuilt.</span> : null}
      {time ? <Tech>controller bundle at {time} UTC · schedule {config.data.schedule}</Tech> : null}
      {live ? <span className={cn('text-[13px]', TONE_TEXT[live.tone])}>{live.say}.</span> : null}
      {store.data ? <Tech>{store.data.summary}</Tech> : null}
    </a>
  );
}
