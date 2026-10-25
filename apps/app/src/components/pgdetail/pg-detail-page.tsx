import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon, DatabaseIcon } from 'lucide-react';
import { Button, EmptyState } from '@swarmy/ui';
import { SayHeader, SectionLink } from '@/components/calm';
import { ErrorState, PageSkeleton } from '@/components/states';
import { PgConnectSection } from './pg-connect-section';
import { PgDetailCode } from './pg-detail-code';
import { pgDetailHeadline } from './pg-detail-headline';
import { PgExtensionsSection } from './pg-extensions-section';
import { PgFailoverSection } from './pg-failover-section';
import { PgModeApply } from './pg-mode-apply';
import { standbyBoxStats } from './pg-replication';
import { PgReplicationSection } from './pg-replication-section';
import { PgSizeSection } from './pg-size-section';
import { PgTopologySection } from './pg-topology-section';
import type { PgMode } from './pg-topology';
import { usePgDetail } from './use-pg-detail';
import { usePgReplication } from './use-pg-replication';

function Back({ stack }: { stack: string }): React.JSX.Element {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit pointer-coarse:min-h-11">
      <Link to="/stacks/$name/data" params={{ name: stack }}>
        <ArrowLeftIcon className="size-4" /> All of {stack}’s data
      </Link>
    </Button>
  );
}

/**
 * One managed Postgres database (board 39, PgDetail): the sentence, how it's
 * laid out (a diagram that morphs with the picked shape, what you could lose
 * and how long it's down), extensions; the aside carries the code, the
 * switch-over rule with "Simulate <region> outage", Connect and its size.
 */
export function PgDetailPage({ stack, cluster }: { stack: string; cluster: string }): React.JSX.Element {
  const d = usePgDetail(stack, cluster);
  const r = usePgReplication(stack, d.cluster);
  const [picked, setPicked] = React.useState<PgMode | null>(null);

  if (d.pending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  if (d.error) return <ErrorState title="Couldn’t load this database" error={d.error} retry={d.retry} />;
  const c = d.cluster;
  if (!c) {
    return (
      <div className="flex flex-col gap-4">
        <Back stack={stack} />
        <EmptyState
          icon={<DatabaseIcon />}
          title={`${stack} has no database called ${cluster}`}
          description="It may have been removed, or it belongs to another app."
        />
      </div>
    );
  }

  const mode = picked ?? c.topology;
  const head = pgDetailHeadline(d);
  return (
    <div className="flex flex-col gap-5">
      <Back stack={stack} />
      <SayHeader
        size="md"
        eyebrow={`${c.name} · postgres`}
        title={head.title}
        lede={head.lede}
        actions={
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Link to="/stacks/$name/backups" params={{ name: stack }} hash={`pg-${c.name}`} className="min-h-11 content-center">
              <SectionLink>Backups →</SectionLink>
            </Link>
            <Link to="/stacks/$name/studio" params={{ name: stack }} search={{ db: c.name }} className="min-h-11 content-center">
              <SectionLink>Open studio →</SectionLink>
            </Link>
            <Link to="/stacks/$name/data" params={{ name: stack }} hash="cache" className="min-h-11 content-center">
              <SectionLink>Cache &amp; search →</SectionLink>
            </Link>
          </div>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <PgTopologySection stack={stack} d={d} mode={mode} onMode={setPicked} behind={r.view ? standbyBoxStats(r.view.standbys) : undefined} />
          <PgModeApply stack={stack} d={d} mode={mode} />
          <PgReplicationSection d={d} r={r} />
          <PgExtensionsSection stack={stack} d={d} />
        </div>
        <aside aria-label={`About ${c.name}`} className="flex min-w-0 flex-col gap-5">
          <PgDetailCode stack={stack} d={d} mode={mode} />
          <PgFailoverSection stack={stack} d={d} />
          <PgConnectSection stack={stack} d={d} />
          <PgSizeSection stack={stack} d={d} />
        </aside>
      </div>
    </div>
  );
}
