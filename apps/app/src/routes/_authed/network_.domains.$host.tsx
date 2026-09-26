import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { DomainVerifyPage } from '@/components/domains/domain-verify-page';

/** One domain's verification view: DNS → verified → certificate → active. */
export const Route = createFileRoute('/_authed/network_/domains/$host')({
  component: DomainVerifyRoute,
});

function DomainVerifyRoute(): React.JSX.Element {
  const { host } = Route.useParams();
  return <DomainVerifyPage key={host} host={host} />;
}
