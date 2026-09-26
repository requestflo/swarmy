import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CalmPage } from '@/components/calm';
import { ErrorState, PageSkeleton } from '@/components/states';
import { ConfigureForm } from './configure-form';

/**
 * Deploy → Configure (board 3), `/deploy/<template>`: loads the template and
 * hands it to the form. An unknown id says so and offers every template.
 */
export function ConfigurePage({ templateId }: { templateId: string }): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.blueprints.list.queryOptions());
  const meta = list.data?.find((m) => m.id === templateId && !m.docOnly) ?? null;
  if (meta) return <ConfigureForm key={meta.id} meta={meta} />;
  return (
    <CalmPage crumbs={[{ label: 'Deploy', to: '/deploy' }, { label: templateId }]}>
      {list.isPending ? (
        <PageSkeleton />
      ) : list.isError ? (
        <ErrorState title="Couldn't load the templates." error={list.error} retry={() => void list.refetch()} />
      ) : (
        <div className="calm-card flex flex-col items-start gap-3 px-5 py-6">
          <p className="text-[15px] font-semibold">There’s no template called “{templateId}”.</p>
          <Button asChild variant="outline" className="pointer-coarse:min-h-11">
            <Link to="/blueprints">See every template</Link>
          </Button>
        </div>
      )}
    </CalmPage>
  );
}
