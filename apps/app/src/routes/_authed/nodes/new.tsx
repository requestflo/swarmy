import { createFileRoute } from '@tanstack/react-router';
import { AddServerPage } from '@/components/onboarding/add-server-page';

/** Add a server: one line to paste, then watch it join (components/onboarding). */
export const Route = createFileRoute('/_authed/nodes/new')({
  component: AddServerPage,
});
