import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { LockKeyholeIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/secrets')({
  component: SecretsPage,
});

function SecretsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Governance · Secrets"
        title={
          <>
            <em>Secrets</em>.
          </>
        }
        description="Docker-native secret families with versions, rotation and a usage map. Values are write-only."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<LockKeyholeIcon />}
          title="No secrets yet"
          description="Create a secret family and rotate it safely — swarmy tracks versions and consumers."
        />
      </div>
    </div>
  );
}
