import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SparklesIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/ai')({
  component: AiPage,
});

function AiPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data · AI"
        title={
          <>
            AI <em>gateway</em>.
          </>
        }
        description="One gateway for every model provider — virtual keys, budgets, usage and request logs."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<SparklesIcon />}
          title="No providers yet"
          description="Add a provider, mint virtual keys, and route every model call through one gateway."
        />
      </div>
    </div>
  );
}
