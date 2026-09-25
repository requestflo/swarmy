import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CalmRow, RowList, Section, SectionLink } from '@/components/calm';
import { SkeletonBody } from '@/components/states';
import { DISK_HOT_PCT, type FleetServer } from './use-fleet';
import { plainRoles, serverTone, techRoles } from './server-words';

/**
 * The fleet as one quiet list: each server's name, what it does in plain
 * words, and its status word. Picking a row fills the inspector.
 */
export function ServersList({
  servers,
  pending,
  selectedId,
  onSelect,
}: {
  servers: FleetServer[];
  pending: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <Section
      title="Your servers"
      count={pending ? undefined : servers.length}
      flush
      action={
        <Link to="/nodes/new">
          <SectionLink>Add a server →</SectionLink>
        </Link>
      }
    >
      {pending ? (
        <SkeletonBody variant="list" />
      ) : servers.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          No servers yet. <Link to="/nodes/new" className="text-primary font-semibold hover:underline">Add one</Link>{' '}
          with a single line.
        </p>
      ) : (
        <RowList label="Servers">
          {servers.map((s) => {
            const { tone, word } = serverTone(s.node);
            const hot = s.node.status === 'online' && s.diskPct !== null && s.diskPct >= DISK_HOT_PCT;
            const say = [
              plainRoles(s.node)[0],
              s.diskPct !== null ? `disk ${s.diskPct}%` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            const tech = [
              techRoles(s.node),
              s.node.region,
              s.monthlyUsd != null ? `$${s.monthlyUsd.toFixed(0)}/mo` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <CalmRow
                key={s.node.id}
                tone={hot ? 'warn' : tone}
                name={s.node.name}
                sub={s.node.hostname}
                say={say}
                tech={tech}
                word={hot ? `Disk ${s.diskPct}%` : word}
                wordTone={hot ? 'warn' : tone}
                onClick={() => onSelect(s.node.id)}
                className={selectedId === s.node.id ? 'bg-foreground/[0.04]' : undefined}
              />
            );
          })}
        </RowList>
      )}
    </Section>
  );
}
