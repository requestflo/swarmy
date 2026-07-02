import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ShieldCheckIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/governance')({
  component: GovernancePage,
});

function GovernancePage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Guardrails"
        title={
          <>
            <em>Guardrails</em>.
          </>
        }
        description="Rules that keep production safe — image policy, replicas, backups and resource limits."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<ShieldCheckIcon />}
          title="Guardrails coming online"
          description="Toggle rules like no-latest-in-prod and minimum replicas — violations block deploys."
        />
      </div>
    </div>
  );
}
