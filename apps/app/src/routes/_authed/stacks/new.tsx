import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SectionHeader } from '@/components/section-header';
import { DeployStackForm } from '@/components/stacks/new/deploy-stack-form';

/** Deploy an app from a compose file (a Deploy step): paste, check, deploy. */
export const Route = createFileRoute('/_authed/stacks/new')({
  component: NewStackPage,
});

function NewStackPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24 lg:pb-20 xl:px-10">
      <SectionHeader
        eyebrow="Nothing runs until you press Deploy"
        title="Paste a compose file."
        description="Every service goes up at once and lands in one app. swarmy checks the file as you type."
      />
      <DeployStackForm />
    </div>
  );
}
