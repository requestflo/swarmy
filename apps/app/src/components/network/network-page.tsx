import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, cn } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { NextAction, Say, Section, SectionLink } from '@/components/calm';
import { PageSkeleton, PageError } from '@/components/states';
import { GeoDnsSection } from '@/components/geo/geodns-section';
import { DRIVER_LABELS, type IngressDriverId } from '@/components/ingress/driver-config';
import { useNetwork } from './use-network';
import { DomainList } from './domain-list';
import { VisitorFlow } from './visitor-flow';
import { AddDomainDialog } from './add-domain-dialog';
import { NetworkCode } from './network-code';

/** Network hub — its tab is "Domains": every address, where it goes, and whether HTTPS is on. */
export function NetworkPage(): React.JSX.Element {
  const n = useNetwork();
  const [adding, setAdding] = React.useState(false);
  const [view, setView] = React.useState<'list' | 'picture'>('list');

  if (n.error && !n.ready) return <Shell><PageError error={n.error} retry={n.retry} /></Shell>;
  if (!n.ready) return <PageSkeleton variant="list" />;

  const total = n.domains.length;
  const doors = n.frontDoors === 1 ? 'your front door' : `the nearest of ${n.frontDoors} front doors`;
  const first = n.needs[0];
  const driver = DRIVER_LABELS[(n.config?.driver ?? 'none') as IngressDriverId];
  const title =
    total === 0 ? (
      <>No addresses yet. <em>Give an app its own.</em></>
    ) : n.onHttps === total ? (
      <>
        {total} address{total === 1 ? '' : 'es'}, all on HTTPS. <em>Visitors reach {doors}.</em>
      </>
    ) : (
      <>
        {n.onHttps} of {total} addresses on HTTPS.{' '}
        <Say tone="warn">{total - n.onHttps} need{total - n.onHttps === 1 ? 's' : ''} a look.</Say>
      </>
    );

  return (
    <Shell>
      <SectionHeader
        title={title}
        description={
          total === 0
            ? 'Point a domain at an app. swarmy gets its HTTPS certificate and renews it.'
            : `${total} address${total === 1 ? '' : 'es'} across ${new Set(n.domains.map((d) => d.stack)).size} apps. Certificates renew themselves.`
        }
        actions={
          <Button variant={first ? 'outline' : 'default'} onClick={() => setAdding(true)}>
            Add a domain
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          {first ? (
            <NextAction
              title={`${first.host} is waiting for its address record`}
              tech={first.status?.reason}
              actions={
                <Button asChild>
                  <Link to="/stacks/$name/network" params={{ name: first.stack }}>Show the record to add</Link>
                </Button>
              }
            >
              Add one record at your registrar. swarmy checks every minute, then gets HTTPS by itself.
            </NextAction>
          ) : null}
          <Section
            title="Domains"
            count={total}
            flush={view === 'list'}
            action={<ViewToggle view={view} onChange={setView} />}
          >
            {view === 'list' ? (
              <DomainList domains={n.domains} onAdd={() => setAdding(true)} />
            ) : (
              <VisitorFlow domains={n.domains} frontDoors={n.frontDoors} driverLabel={driver} geoOn={n.geoOn} />
            )}
          </Section>
          <GeoDnsSection />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <NetworkCode domains={n.domains} zones={n.zones} />
          <Section title="Front door" action={<Link to="/ingress"><SectionLink>Settings →</SectionLink></Link>}>
            <p className="text-muted-foreground text-[13.5px]">
              {n.config?.runtime?.serving ? `HTTPS is on. ${driver} serves every address.` : n.config?.runtime?.message}
            </p>
          </Section>
        </aside>
      </div>
      <AddDomainDialog open={adding} onOpenChange={setAdding} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">{children}</div>;
}

function ViewToggle({ view, onChange }: { view: 'list' | 'picture'; onChange: (v: 'list' | 'picture') => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="View" className="border-border inline-flex rounded-[10px] border p-0.5">
      {(['list', 'picture'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onChange(v)}
          className={cn(
            'h-7 rounded-[8px] px-2.5 text-xs font-semibold capitalize pointer-coarse:min-h-11',
            view === v ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
