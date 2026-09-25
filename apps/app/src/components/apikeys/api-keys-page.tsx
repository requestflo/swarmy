import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CodeView, Depth, Section } from '@/components/calm';
import { RowPage, plural } from '@/components/rowpage/row-page';
import { apiCode } from './api-code';
import { ApiKeysTab } from './api-keys-tab';
import { CliSection } from './cli-section';
import { NewKeyForm } from './new-key-form';
import { OauthClientsTab } from './oauth-clients-tab';

/** Settings → API, CLI & MCP: keys for the API, SDKs, Terraform, the CLI and coding agents. */
export function ApiKeysPage(): React.JSX.Element {
  const trpc = useTRPC();
  const keys = useQuery(trpc.apiKeys.list.queryOptions());
  const [creating, setCreating] = React.useState(false);
  const active = (keys.data ?? []).filter((k) => k.status === 'active');
  const writers = active.filter((k) => k.scopes.includes('write')).length;
  const title = !keys.data ? (
    'API, CLI and MCP.'
  ) : (
    <>
      {plural(active.length, 'key')} can reach swarmy. <em>{writers ? `${writers} can change things.` : 'All read-only.'}</em>
    </>
  );
  return (
    <RowPage
      title={title}
      description="The REST API, the SDKs, Terraform, the swarmy CLI and coding agents all use the same keys, scoped to this workspace and to what you can do."
      actions={
        <Button className="pointer-coarse:min-h-11" onClick={() => setCreating(true)} disabled={creating}>
          <PlusIcon className="size-4" /> New API key
        </Button>
      }
      aside={<CodeView title="Connect it" tabs={apiCode()} note="Real commands: the CLI, the MCP server it serves, and the key endpoints of the public API." />}
    >
      {creating ? <NewKeyForm onDone={() => setCreating(false)} /> : null}
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
