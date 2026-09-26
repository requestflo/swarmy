import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Tech } from '@/components/calm';
import { imageTag, personName } from '@/components/apps/app-words';
import { TextSkeleton } from '@/components/states';
import { relTime } from '@/lib/format';
import { appDataCoverage, dataFactWords } from '@/components/backups/app-data-coverage';
import type { AppFacts } from './use-app-facts';

function Fact({ label, value, tech, link }: { label: string; value: React.ReactNode; tech?: React.ReactNode; link?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-border grid grid-cols-[92px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b py-3 last:border-b-0">
      <dt className="text-muted-foreground pt-px text-[12.5px]">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1 text-[13.5px]">
        {value ?? <TextSkeleton className="w-32" />}
        {tech ? <Tech>{tech}</Tech> : null}
      </dd>
      <dd className="pt-px">{link}</dd>
    </div>
  );
}

function FactLink({ to, stack, children }: { to: string; stack: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Link to={to} params={{ name: stack } as never} className="text-primary font-mono text-[11.5px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center">
      {children}
    </Link>
  );
}

/** Address · Last change · Data · Who can change it — plain facts, tech lines from Controls. */
export function AppFacts({ stack, f }: { stack: string; f: AppFacts }): React.JSX.Element {
  const domain = f.domains?.[0];
  const https = domain && domain.serving && (domain.tls === 'auto' || domain.tls === 'custom');
  const [last, prev] = f.releases ?? [];
  const lastTag = last?.images[0] ? imageTag(last.images[0].image) : null;
  const prevTag = prev?.images[0] ? imageTag(prev.images[0].image) : null;
  const dbs = f.coverage?.databases ?? [];
  const vols = f.coverage?.volumes ?? [];
  const dest = f.coverage?.destination;
  const data = appDataCoverage(stack, f.coverage, f.managedDbs);
  const owners = (f.members ?? []).filter((m) => m.role !== 'member').length;

  return (
    <section aria-label="Facts" className="calm-card px-5 py-1">
      <dl>
        <Fact
          label="Address"
          value={f.domains ? (domain ? <span className="flex items-center gap-2"><span className="truncate">{domain.host}</span>{https ? <span className="text-tone-ok font-mono text-[11px] font-semibold">HTTPS</span> : null}</span> : 'No address yet') : undefined}
          tech={domain ? `${domain.serviceName}:${domain.targetPort} · tls ${domain.tls} · edge ${domain.edgeState}${f.domains!.length > 1 ? ` · also ${f.domains!.slice(1).map((d) => d.host).join(', ')}` : ''}` : undefined}
          link={<FactLink to="/stacks/$name/network" stack={stack}>{domain ? 'Domains' : 'Add one'}</FactLink>}
        />
        <Fact
          label="Last change"
          value={f.releases ? (last ? `${lastTag ?? 'A change'} by ${personName(last.actor)}, ${relTime(last.createdAt)}` : 'Nothing deployed through swarmy yet') : undefined}
          tech={last ? `${last.id} · ${last.status}${last.strategy ? ` · ${last.strategy.type}` : ''}` : undefined}
          link={prev ? <FactLink to="/stacks/$name/releases" stack={stack}>Put back {prevTag ?? 'the last one'}</FactLink> : null}
        />
        <Fact
          label="Data"
          value={f.coverage && f.managedDbs ? dataFactWords(data) : undefined}
          tech={data.keepsNothing ? undefined : [...data.mine.map((r) => `${r.cluster} · ${r.engine ?? 'postgres'} · ${r.cron ?? 'no schedule'}`), ...dbs.map((d) => `${d.name} · ${d.engine} · ${d.method}`), ...vols.map((v) => v.volume)].join('  ') + (dest ? `  → ${dest.name}` : '')}
          link={<FactLink to="/stacks/$name/backups" stack={stack}>Backups</FactLink>}
        />
        <Fact
          label="Can change it"
          value={f.members ? `${f.members.length} ${f.members.length === 1 ? 'person' : 'people'} in your workspace` : undefined}
          tech={f.members ? `${owners} owner/admin · ${f.members.length - owners} member` : undefined}
          link={<Link to="/settings/access" className="text-primary font-mono text-[11.5px] hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center">Rules</Link>}
        />
      </dl>
    </section>
  );
}
