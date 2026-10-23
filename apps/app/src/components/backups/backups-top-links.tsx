import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Quiet jumps from /backups: a database's own backups (the one that restores to any second first) and swarmy's. */
export function BackupsTopLinks(): React.JSX.Element {
  const trpc = useTRPC();
  const overview = useQuery(trpc.dbBackups.overview.queryOptions());
  const db = overview.data?.find((r) => r.pitr) ?? overview.data?.[0] ?? null;
  return (
    <div className="flex flex-wrap gap-2">
      {db ? (
        <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
          <Link to="/stacks/$name/backups" params={{ name: db.stack }} hash={`pg-${db.cluster}`}>
            Database backups
          </Link>
        </Button>
      ) : null}
      <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
        <a href="#swarmy-itself">swarmy’s own backup</a>
      </Button>
    </div>
  );
}
