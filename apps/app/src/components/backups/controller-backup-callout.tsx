import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, ShieldCheckIcon } from 'lucide-react';
import { Card, CardContent, StatusBadge } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { relativeTime } from './backup-format';

/** Link-out to controller-state backups (swarmy's own brain) in Settings. */
export function ControllerBackupCallout(): React.JSX.Element {
  const trpc = useTRPC();
  const config = useQuery(trpc.controllerBackup.getConfig.queryOptions());
  const enabled = Boolean(config.data?.enabled);

  return (
    <Card className="card-pop border-0">
      <CardContent className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-accent flex size-10 shrink-0 items-center justify-center rounded-xl">
            <ShieldCheckIcon className="text-muted-foreground size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold">Controller backups</p>
            <p className="text-muted-foreground mt-0.5 text-sm">
              swarmy's own state — orgs, nodes, settings, audit —{' '}
              {enabled
                ? `last bundled ${relativeTime(config.data?.lastRunAt ?? null)}.`
                : 'has no recovery bundle yet.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge tone={enabled ? 'online' : 'warning'} label={enabled ? 'on' : 'off'} />
          <Link
            to="/settings/backup"
            className="text-primary flex items-center gap-1 text-sm font-bold hover:underline"
          >
            Settings <ArrowRightIcon className="size-4" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
