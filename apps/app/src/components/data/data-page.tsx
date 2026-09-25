import * as React from 'react';
import { SectionHeader } from '@/components/section-header';

/** Data hub (Calm Layers). Placeholder until its slice lands — see plans/redesign-build.md. */
export function DataPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader title="Everything your apps keep, and whether it's safe." />
    </div>
  );
}
