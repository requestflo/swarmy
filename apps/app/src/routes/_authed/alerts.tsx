import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { BellIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/alerts')({
  component: AlertsPage,
});

function AlertsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Alerts"
        title={
          <>
            <em>Alerts</em>.
          </>
        }
        description="Rules, channels and the firing feed — swarmy tells you before your users do."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<BellIcon />}
          title="No alerts firing"
          description="Wire a notification channel and swarmy’s default rules start watching your estate."
        />
      </div>
    </div>
  );
}
