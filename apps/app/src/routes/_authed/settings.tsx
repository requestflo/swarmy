import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { TerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { SectionHeader } from '@/components/section-header';
import { SettingsTabs } from '@/components/settings/settings-tabs';

export const Route = createFileRoute('/_authed/settings')({
  component: SettingsPage,
});

function SettingsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Settings"
        title={
          <>
            Run the <em>team</em>.
          </>
        }
        description="Your org, who's in it, and the tokens that let nodes join the swarm."
        actions={
          <Button asChild>
            <Link to="/nodes/new">
              <TerminalIcon className="size-4" /> Enroll a node
            </Link>
          </Button>
        }
      />
      <SettingsTabs />
    </div>
  );
}
