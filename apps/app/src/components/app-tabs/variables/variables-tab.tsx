import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlreadyOn, CodeView, Depth, Say, SayHeader, Section } from '@/components/calm';
import { StackConfigsSection } from '@/components/configsmgr/stack-configs-section';
import { StackSecretsSection } from '@/components/secretsmgr/stack-secrets-section';
import { HeaderSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { RowsSkeleton, TabBody, plural } from '../tab-body';
import { useStackServices } from '../use-stack-services';
import { collectVariables, variablesCode } from './variables-model';
import { VariablesList } from './variables-list';
import { VariablesNext } from './variables-next';

/** Variables & secrets: every setting the app runs with, secrets write-only. Boards AppVariables · RSecrets · EnvPaste. */
export function VariablesTab({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const [createOpen, setCreateOpen] = React.useState(false);
  const { services } = useStackServices(stack);
  const secrets = useQuery({ ...trpc.secrets.list.queryOptions({ stack }), refetchInterval: 5_000 });
  const families = secrets.data?.families ?? [];
  const rows = React.useMemo(() => (services ? collectVariables(stack, services) : []), [stack, services]);
  const ready = !!services && !!secrets.data;

  const stale = families.filter((f) => f.staleConsumers > 0).length;
  const loose = rows.filter((r) => r.secretLooking).length;
  const title = !ready ? null : (
    <>
      {stack} has {plural(rows.length + families.length, 'setting')};{' '}
      {families.length === 0 ? 'none are secrets' : families.length === 1 ? '1 is a secret' : `${families.length} are secrets`}.{' '}
      {stale > 0 ? (
        <Say tone="warn">{stale === 1 ? 'One is out of date.' : `${stale} are out of date.`}</Say>
      ) : loose > 0 ? (
        <Say tone="warn">{loose === 1 ? 'One should be a secret.' : `${loose} should be secrets.`}</Say>
      ) : (
        <em>All set.</em>
      )}
    </>
  );

  return (
    <TabBody
      header={
        title ? (
          <SayHeader
            size="md"
            title={title}
            lede="Secrets reach your services as files and are never shown again. When a plain variable changes, swarmy restarts one copy at a time."
          />
        ) : (
          <HeaderSkeleton />
        )
      }
      aside={
        <>
          {ready ? <CodeView title="Settings as code" tabs={variablesCode(stack, services, families)} source="yaml" /> : null}
          <AlreadyOn
            title="How secrets work here"
            items={[
              { what: 'Write-only', detail: 'stored by Docker, encrypted, never sent back' },
              { what: 'Versioned', detail: 'every change is kept, so you can put one back' },
              { what: 'Audited', detail: 'who set or changed what, never the value' },
            ]}
          />
        </>
      }
    >
      {ready ? <VariablesNext families={families} rows={rows} onAddSecret={() => setCreateOpen(true)} /> : null}
      <StackSecretsSection stack={stack} createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
      <Section title="Plain variables" count={services ? rows.length : undefined} hint="readable by the app" flush>
        {services ? <VariablesList stack={stack} rows={rows} services={services} /> : <RowsSkeleton />}
      </Section>
      <Depth at="controls">
        <StackConfigsSection stack={stack} />
      </Depth>
    </TabBody>
  );
}
