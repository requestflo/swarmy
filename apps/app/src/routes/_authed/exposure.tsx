import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ShieldAlertIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/exposure')({
  component: ExposurePage,
});

function ExposurePage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Network · Exposure"
        title={
          <>
            <em>Exposure</em>.
          </>
        }
        description="What’s public, what’s private, what’s protected — audited across every service and port."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<ShieldAlertIcon />}
          title="Nothing audited yet"
          description="swarmy scans every service for published ports and routes — verdicts land here."
        />
      </div>
    </div>
  );
}
