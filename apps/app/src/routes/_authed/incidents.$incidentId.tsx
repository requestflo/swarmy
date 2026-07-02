import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SirenIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/incidents/$incidentId')({
  component: IncidentDetailPage,
});

function IncidentDetailPage(): React.JSX.Element {
  const { incidentId } = Route.useParams();
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Incident"
        title={
          <>
            Incident <em>timeline</em>.
          </>
        }
        description={`Incident ${incidentId} — details will appear here once the slice lands.`}
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<SirenIcon />}
          title="Incident details land here"
          description="The timeline — what fired, what swarmy did, when it resolved — arrives with the incidents slice."
        />
      </div>
    </div>
  );
}
