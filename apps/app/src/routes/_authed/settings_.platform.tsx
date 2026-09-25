import { createFileRoute } from '@tanstack/react-router';
import { PlatformPage } from '@/components/platform/platform-page';

export const Route = createFileRoute('/_authed/settings_/platform')({
  component: PlatformPage,
});
