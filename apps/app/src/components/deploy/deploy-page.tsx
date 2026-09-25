import * as React from 'react';
import { SectionHeader } from '@/components/section-header';

/** Deploy an app hub (Calm Layers). Placeholder until its slice lands — see plans/redesign-build.md. */
export function DeployPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader title="What are you deploying?" />
    </div>
  );
}
