import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth, Section } from '@/components/calm';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { apiCode } from './api-code';
import { ApiKeysTab } from './api-keys-tab';
import { CliSection } from './cli-section';
import { soonestExpiry } from './key-words';
import { NewKeyPanel } from './new-key-panel';
import { OauthClientsTab } from './oauth-clients-tab';

/** Settings → API, CLI & MCP: keys for the API, SDKs, Terraform, the CLI and coding agents. */
export function ApiKeysPage(): React.JSX.Element {
  const trpc = useTRPC();
  const keys = useQuery(trpc.apiKeys.list.queryOptions());
  const org = useQuery(trpc.org.currentOrg.queryOptions());
  const isAdmin = org.data?.role === 'owner' || org.data?.role === 'admin';
  const active = (keys.data ?? []).filter((k) => k.status === 'active');
  const soon = keys.data ? soonestExpiry(keys.data) : null;
  const scoped = active.filter((k) => k.stackNames).length;
  const title = !keys.data ? (
    'API, CLI and MCP.'
  ) : (
    <>
      {plural(active.length, 'key')} can reach swarmy.{' '}
      <em>{soon ?? (scoped ? `${scoped} ${scoped === 1 ? 'is' : 'are'} limited to some apps.` : 'None expire soon.')}</em>
    </>
  );
  return (
    <RowPage
      title={title}
      description="The REST API, the SDKs, Terraform, the swarmy CLI and coding agents all use the same keys. A key acts as the person who made it, only on the apps you pick, until it expires."
      aside={
        <>
          <CodeView title="Use a key" tabs={apiCode()} note="Real calls: POST /api/v1/stacks and /api-keys, the Terraform provider's swarmy_api_key and swarmy_stack, the CLI and the MCP server." />
          {isAdmin ? <NewKeyPanel /> : null}
        </>
      }
    >
      <ApiKeysTab />
      <CliSection />
      <Depth at="controls">
        <Section title="OAuth clients" hint="rotating tokens for machines, instead of a static key">
          <OauthClientsTab />
        </Section>
      </Depth>
    </RowPage>
  );
}
