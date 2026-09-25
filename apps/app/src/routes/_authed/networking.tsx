import { createFileRoute } from '@tanstack/react-router';
import { PrivateNetworkPage } from '@/components/networking/private-network-page';

/** "Private network" (was Mesh): servers and laptops on one encrypted network. */
export const Route = createFileRoute('/_authed/networking')({
  component: PrivateNetworkPage,
});
