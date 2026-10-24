import * as React from 'react';
import { PlanColumn } from '@/components/gitops/plan-graph';
import type { PlanNode } from '@/components/gitops/plan-graph-model';
import { GitChip } from './git-chip';
import type { AppGraph } from './git-scan-types';

const add = (key: string, label: string, meta: string, note?: string): PlanNode => ({ key, label, meta, diff: 'add', ...(note ? { note } : {}) });

/**
 * "The app it will create": what `toDesired` makes of the generated
 * swarmy.yaml, drawn with the PR plan's boxes — everything is new, so
 * every box is an add. Each service says what it is wired to.
 */
export function GitScanGraph({ graph, stale }: { graph: AppGraph | null; stale: boolean }): React.JSX.Element {
  const services = graph?.services.map((s) => add(`s:${s.name}`, s.name, s.meta, s.wires.length ? `→ ${s.wires.join(' · ')}` : undefined)) ?? [];
  const data = graph?.data.map((r) => add(`r:${r.name}`, r.name, r.meta)) ?? [];
  const jobs = graph?.jobs.map((j) => add(`j:${j.name}`, j.name, j.meta)) ?? [];
  return (
    <section aria-label="The app it will create" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="calm-eyebrow">The app it will create</span>
        {graph ? (
          <GitChip mono className="ml-auto">
            {graph.stack}
          </GitChip>
        ) : null}
      </div>
      {graph ? (
        <figure className={stale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <div className="flex flex-col gap-4 rounded-xl border bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px] p-4 sm:flex-row">
            <PlanColumn title="Services" nodes={services} />
            <PlanColumn title="Data" nodes={data} />
            <PlanColumn title="Jobs" nodes={jobs} />
          </div>
          <figcaption className="text-muted-foreground mt-2 font-mono text-[11px]">wiring is injected — no connection strings in git</figcaption>
        </figure>
      ) : (
        <p className="text-muted-foreground rounded-xl border px-4 py-6 text-[13px]">Fix the swarmy.yaml below and the app appears here.</p>
      )}
    </section>
  );
}
