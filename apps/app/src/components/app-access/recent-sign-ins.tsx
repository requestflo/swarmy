import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalmRow, RowList, Section, SectionLink } from '@/components/calm';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { absTime, relTime } from '@/lib/format';
import type { AppSignIn } from './types';

const SHOWN = 10;

function where(r: AppSignIn): string | null {
  if (!r.host) return null;
  return r.path && r.path !== '/' ? `${r.host}${r.path}` : r.host;
}

/**
 * Recent sign-ins (AppAccess board): who signed in to the app, when and how
 * (the swarmy sign-in they used), and who was turned away and why. Read from
 * the audit log — one row per sign-in, refusals at most once a minute per
 * person — so it is kept exactly as long as the org keeps its audit log.
 */
export function RecentSignIns({ stack }: { stack: string }): React.JSX.Element | null {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.appAccess.signIns.queryOptions({ stack, limit: SHOWN }), refetchInterval: 15_000 });
  if (q.isPending) return <CardSkeleton lines={3} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />;
  const rows = q.data as AppSignIn[];
  const denied = rows.filter((r) => r.outcome === 'denied').length;

  return (
    <Section
      title="Recent sign-ins"
      count={rows.length ? `${rows.length - denied} in · ${denied} turned away` : undefined}
      hint="kept as long as your audit log"
      action={
        <Link to="/audit">
          <SectionLink>Activity →</SectionLink>
        </Link>
      }
      flush
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-3 text-sm">
          Nobody has signed in yet. Once someone does, you’ll see who, when and how here.
        </p>
      ) : (
        <RowList label="Recent sign-ins">
          {rows.map((r) => (
            <CalmRow
              key={r.id}
              tone={r.outcome === 'allowed' ? 'ok' : 'bad'}
              name={r.email ?? r.name ?? 'Someone'}
              sub={<time dateTime={r.at} title={absTime(r.at)}>{relTime(r.at)}</time>}
              say={r.outcome === 'allowed' ? `Signed in${r.via ? ` with ${r.via}` : ''}.` : `${r.reason ?? 'Turned away'}.`}
              tech={where(r)}
              word={r.outcome === 'allowed' ? 'Allowed' : 'Denied'}
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}
