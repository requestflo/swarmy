import { createFileRoute } from '@tanstack/react-router';
import { NetworkPage } from '@/components/network/network-page';

export const Route = createFileRoute('/_authed/network')({
  component: NetworkPage,
});
