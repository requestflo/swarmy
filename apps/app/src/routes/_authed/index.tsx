import { createFileRoute } from '@tanstack/react-router';
import { AppsPage } from '@/components/apps/apps-page';

/**
 * Apps — every app you run as a calm list, with the estate map as a
 * List | Map view toggle. Each app opens its workspace at /stacks/$name.
 */
export const Route = createFileRoute('/_authed/')({
  component: AppsPage,
});
