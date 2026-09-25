import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { DatabaseIcon } from 'lucide-react';
import { CalmRow, RowList, Section, SectionLink } from '@/components/calm';
import { EmptyState } from '@/components/states';
import type { EstateData } from './use-estate-data';

/** Every store, grouped by app, one flat row each; each app links into its own Data tab. */
export function DataGroups({ d }: { d: EstateData }): React.JSX.Element {
  if (d.items.length === 0) {
    return (
      <Section title="Your data">
        <EmptyState
          icon={<DatabaseIcon />}
          title="Nothing stored yet"
          description="Add a database or a bucket to an app and it shows up here with how it's kept safe."
        />
      </Section>
    );
  }
  return (
    <>
      {d.apps.map((app) => {
        const rows = d.items.filter((i) => i.app === app);
        return (
          <Section
            key={app}
            title={app === 'Shared' ? 'Not attached to an app' : app}
            count={`${rows.length} store${rows.length === 1 ? '' : 's'}`}
            flush
            action={
              app === 'Shared' ? (
                <Link to="/data/buckets"><SectionLink>Buckets →</SectionLink></Link>
              ) : (
                <Link to="/stacks/$name/data" params={{ name: app }}><SectionLink>Data tab →</SectionLink></Link>
              )
            }
          >
            <RowList label={`${app} data`}>
              {rows.map((r) => (
                <CalmRow
                  key={r.key}
                  tone={r.tone}
                  name={r.name}
                  sub={r.kind}
                  say={r.say}
                  tech={r.tech}
                  word={r.word}
                  to={r.kind === 'Bucket' ? '/data/buckets' : '/stacks/$name/data'}
                  params={r.kind === 'Bucket' ? undefined : { name: r.app }}
                />
              ))}
            </RowList>
          </Section>
        );
      })}
    </>
  );
}
