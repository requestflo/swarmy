import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ServerIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { CalmTopBar } from '@/components/calm';

/** A calm not-found for an unknown server id (a 404 isn't worth a retry), like the unknown-app page. */
export function ServerNotFound({ nodeId }: { nodeId: string }): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col">
      <CalmTopBar crumbs={[{ label: 'Servers', to: '/nodes' }, { label: nodeId }]} />
      <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 xl:px-8">
        <EmptyState
          icon={<ServerIcon />}
          title={`No server called “${nodeId}”.`}
          description="It may have been retired, or the link is old. Your other servers are one click away."
          action={
            <Link to="/nodes" className="text-primary font-semibold">
              ← All servers
            </Link>
          }
        />
      </div>
    </div>
  );
}

/** A tRPC NOT_FOUND (or no node and no error at all) means "not found", not "try again". */
export function isNotFound(error: unknown): boolean {
  if (!error) return true;
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === 'NOT_FOUND';
}
