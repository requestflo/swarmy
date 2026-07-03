import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { DeployStackForm } from '@/components/stacks/new/deploy-stack-form';

/** Deploy a stack from a compose file — a focused full page, never a dialog. */
export const Route = createFileRoute('/_authed/stacks/new')({
  component: NewStackPage,
});

function NewStackPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Stacks · New"
        title={
          <>
            Ship a whole app at <em>once</em>.
          </>
        }
        description="Paste a compose file. Every service deploys in one move and lands in its own workspace."
      />
      <DeployStackForm />
    </div>
  );
}
