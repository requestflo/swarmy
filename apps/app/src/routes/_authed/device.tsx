import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { DeviceApproval } from '@/components/cli/device-approval';

interface DeviceSearch {
  code?: string;
}

/** `swarmy login` lands here (verification_uri_complete = /device?code=XXXX-XXXX). */
export const Route = createFileRoute('/_authed/device')({
  validateSearch: (search: Record<string, unknown>): DeviceSearch =>
    typeof search.code === 'string' ? { code: search.code.slice(0, 20) } : {},
  component: DevicePage,
});

function DevicePage(): React.JSX.Element {
  const { code } = Route.useSearch();
  return <DeviceApproval initialCode={code ?? ''} />;
}
