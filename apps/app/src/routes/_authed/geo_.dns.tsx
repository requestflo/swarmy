import { createFileRoute, redirect } from '@tanstack/react-router';

/** DNS health moved to per-row DnsHealthBadge on each stack's Network tab. */
export const Route = createFileRoute('/_authed/geo_/dns')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
