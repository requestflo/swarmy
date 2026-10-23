import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Section } from '@/components/calm';
import { Terminal } from './cli-section';

/**
 * "Is my repo ready for swarmy?" (board 67). The check runs on your machine
 * (`swarmy check`, packages/devkit `checkRepo`) or in your agent (the MCP
 * `check_repo` tool), never on the controller — so this page shows the
 * command, not a result.
 */
export function RepoCheckSection(): React.JSX.Element {
  return (
    <Section title="Is my repo ready for swarmy?">
      <p className="text-muted-foreground text-[13.5px] leading-relaxed">
        Run it in the repo. It finds swarmy.yaml (or a compose file, a Dockerfile, or a stack swarmy can build without one), lists
        what a deploy would create and every problem that would stop it. It deploys nothing and calls no server; your coding
        agent runs the same check.
      </p>
      <Terminal code={'$ swarmy check\n$ swarmy check --config services/orders/swarmy.yaml   # a monorepo app'} label="swarmy check" />
      <Link to="/deploy" search={{ source: 'git' }} className="text-primary w-fit font-mono text-[12px] hover:underline">
        Open in the Git wizard →
      </Link>
    </Section>
  );
}
