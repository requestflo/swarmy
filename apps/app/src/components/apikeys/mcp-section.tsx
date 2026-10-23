import * as React from 'react';
import { Section, Tech } from '@/components/calm';
import { Segmented } from '@/components/domains/segmented';
import { GitChip } from '@/components/ci/git-chip';
import { MCP_CLIENTS, MCP_READ_TOOLS, MCP_DEPLOY_TOOLS, MCP_ADMIN_TOOLS, mcpConfig, type McpClient } from './cli-mcp';
import { Terminal } from './cli-section';

const words = (tools: Array<[string, string]>): string => tools.map(([, say]) => say).join(', ');

/**
 * "MCP server, for coding agents" (board 67): pick your client, paste its
 * line. The tools are the ones the server really registers; the write ones
 * appear only for a credential with the `write` scope.
 */
export function McpSection({ origin }: { origin: string }): React.JSX.Element {
  const [client, setClient] = React.useState<McpClient>('claude');
  return (
    <Section title="MCP server" hint={<GitChip tone="mesh">for coding agents</GitChip>}>
      <Segmented label="Client" value={client} onChange={setClient} options={MCP_CLIENTS} />
      <Terminal code={mcpConfig(client, origin)} label={`${client} config`} />
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Tools: {words(MCP_READ_TOOLS)}. With a Deploy key also {words(MCP_DEPLOY_TOOLS)}; with an Admin key also{' '}
        {words(MCP_ADMIN_TOOLS)}. The key is <b className="text-foreground">read-only by default</b> and scoped by your policies — the
        agent can ship only if you give it a Deploy key (
        <span className="font-mono text-[12px] [font-variant-ligatures:none]">swarmy login --scope read,deploy</span>).{' '}
        <a href="#keys" className="text-primary font-mono text-[12px] hover:underline">
          Manage keys →
        </a>
      </p>
      <Tech>
        {MCP_READ_TOOLS.map(([id]) => id).join(' · ')} · deploy: {MCP_DEPLOY_TOOLS.map(([id]) => id).join(' · ')} · write:{' '}
        {MCP_ADMIN_TOOLS.map(([id]) => id).join(' · ')}
      </Tech>
    </Section>
  );
}
