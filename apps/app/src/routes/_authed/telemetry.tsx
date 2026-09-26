import { createFileRoute } from '@tanstack/react-router';
import { TelemetryPage } from '@/components/telemetry/telemetry-page';

export const Route = createFileRoute('/_authed/telemetry')({
  component: TelemetryPage,
});
