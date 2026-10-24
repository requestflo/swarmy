import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlreadyOn, CodeView, Depth, Say, SayHeader } from '@/components/calm';
import { StackConfigsSection } from '@/components/configsmgr/stack-configs-section';
import { OrphansCard } from '@/components/secretsmgr/orphans-card';
import { HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { TabBody, plural } from '../tab-body';
import type { AddKind } from './use-add-variable';
import { useVarTableData } from './use-var-table-data';
import { rowsFor } from './var-table-model';
import { collectVariables, variablesCode } from './variables-model';
import { VariablesActivity } from './variables-activity';
import { VariablesNext } from './variables-next';
import { VariablesSection } from './variables-section';
import { SharedVariablesSection } from './shared-variables-section';

/** Variables & secrets: every setting the app runs with, secrets write-only. Boards AppVariables · RSecrets · EnvPaste. */
export function VariablesTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [preset, setPreset] = React.useState<{ kind: AddKind; key: string; n: number } | undefined>();
  const data = useVarTableData(stack);
  const { services } = data;
  const secrets = useQuery({ ...trpc.secrets.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const families = secrets.data?.families ?? [];
  const rows = React.useMemo(() => (services ? collectVariables(stack, services) : []), [stack, services]);
  const ready = data.ready && !!secrets.data;
  // The same rows the table lists, so the sentence and the table agree.
  const table = ready ? rowsFor(stack, services ?? [], data.vars, families, null) : [];
  const nSecrets = table.filter((r) => r.kind === 'family' || r.kind === 'secretVar').length;

  const stale = families.filter((f) => f.staleConsumers > 0).length;
  const loose = rows.filter((r) => r.secretLooking).length;
  const title = !ready ? null : (
    <>
      {stack} has {plural(table.length, 'setting')};{' '}
      {nSecrets === 0 ? 'none are secrets' : nSecrets === 1 ? '1 is a secret' : `${nSecrets} are secrets`}.{' '}
      {stale > 0 ? (
        <Say tone="warn">{stale === 1 ? 'One is out of date.' : `${stale} are out of date.`}</Say>
      ) : loose > 0 ? (
        <Say tone="warn">{loose === 1 ? 'One should be a secret.' : `${loose} should be secrets.`}</Say>
      ) : (
        <em>All set.</em>
      )}
    </>
  );
  const keepSecret = (key: string): void => {
    setPreset((p) => ({ kind: 'secret', key, n: (p?.n ?? 0) + 1 }));
    document.getElementById('add-variable')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <TabBody
      header={
        title ? (
          <SayHeader
            size="md"
            title={title}
            lede="Connections fill themselves in. Secrets reach your services as files and are never shown again. When a plain variable changes, swarmy restarts one copy at a time."
          />
        ) : (
          <HeaderSkeleton />
        )
      }
      aside={
        <>
          {ready && services ? <CodeView title="Settings as code" tabs={variablesCode(stack, services, families)} source="yaml" /> : null}
          <AlreadyOn
            title="How secrets work here"
            items={[
              { what: 'Write-only', detail: 'stored by Docker, encrypted, never sent back' },
              { what: 'Versioned', detail: 'every change is kept, so you can put one back' },
              { what: 'Audited', detail: 'who set, revealed or rotated what, never the value' },
            ]}
          />
        </>
      }
    >
      {ready ? <VariablesNext families={families} rows={rows} onAddSecret={keepSecret} /> : null}
      <VariablesSection stack={stack} preset={preset} />
      <SharedVariablesSection stack={stack} />
      <VariablesActivity stack={stack} services={services} families={secrets.data?.families} />
      <Depth at="controls">
        <OrphansCard orphans={secrets.data?.orphans ?? []} />
        <StackConfigsSection stack={stack} />
      </Depth>
    </TabBody>
  );
}
