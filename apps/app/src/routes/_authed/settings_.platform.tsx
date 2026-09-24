import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SectionHeader } from '@/components/section-header';
import { PolicyCard } from '@/components/platform/policy-card';
import { ReleasePanel } from '@/components/platform/release-panel';
import { RunHistory } from '@/components/platform/run-history';
import { useIsPlatformAdmin } from '@/components/platform/use-platform';

export const Route = createFileRoute('/_authed/settings_/platform')({
  component: PlatformPage,
});

/** Settings → Platform: swarmy itself — version, one-button upgrades, channel and patch window. */
function PlatformPage(): React.JSX.Element {
  const admin = useIsPlatformAdmin();
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <SectionHeader
        section="Platform"
        title={
          <>
            Upgrade without <em>rebuilding</em>.
          </>
        }
        description="swarmy itself — the version this cluster runs, signed releases from your channel, and one button that upgrades everything in order, backed up first and rolled back piece by piece."
      />
      <div className="grid gap-6">
        <ReleasePanel admin={admin} />
        <div className="grid gap-6 xl:grid-cols-2">
          <PolicyCard admin={admin} />
          <RunHistory />
        </div>
      </div>
    </div>
  );
}
