import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { MailIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/settings/notifications')({
  component: SettingsNotificationsPage,
});

function SettingsNotificationsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Settings · Notifications"
        title={
          <>
            <em>Notifications</em>.
          </>
        }
        description="Email provider, templates and the delivery log for everything swarmy sends."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<MailIcon />}
          title="No provider configured"
          description="Connect SMTP or an email API so alerts, approvals and invites reach your team."
        />
      </div>
    </div>
  );
}
