import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { FileCogIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/configs')({
  component: ConfigsPage,
});

function ConfigsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Configs"
        title={
          <>
            <em>Configs</em>.
          </>
        }
        description="Versioned Docker configs with diffs, restart previews and rollback."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<FileCogIcon />}
          title="No configs yet"
          description="Create a config, version it, and preview which services restart before you apply."
        />
      </div>
    </div>
  );
}
