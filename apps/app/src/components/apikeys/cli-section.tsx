import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { RowList, Section } from '@/components/calm';
import { LineRow } from '@/components/rowpage/line-row';

/** Terminal and coding agents: what the CLI and MCP give you. Their exact lines are at Code. */
export function CliSection(): React.JSX.Element {
  return (
    <Section title="From your terminal and your coding agent" flush>
      <RowList label="CLI and MCP">
        <LineRow tone="info" name="swarmy CLI" say="Deploy, follow logs, pull variables and run commands with your app’s settings. Sign in once; this dashboard approves it." tech="swarmy login · deploy · logs · env pull · run · status" />
        <LineRow tone="mesh" name="MCP for agents" say="Claude Code, Cursor and other agents get the same tools your key allows, read-only unless you say otherwise." tech="swarmy mcp (stdio) · /mcp (HTTP, API key or OAuth)" />
      </RowList>
      <p className="text-muted-foreground py-2 text-xs">
        Switch to <b className="text-foreground">Code</b> for the install and connect lines. Approving a sign-in from the CLI happens on{' '}
        <Link to="/device" className="text-foreground underline underline-offset-2">the device page</Link>.
      </p>
    </Section>
  );
}
