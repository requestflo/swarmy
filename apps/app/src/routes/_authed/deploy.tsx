import { createFileRoute } from '@tanstack/react-router';
import { DeployPage } from '@/components/deploy/deploy-page';
import { parseDeploySearch } from '@/components/deploy/deploy-search';

export const Route = createFileRoute('/_authed/deploy')({
  validateSearch: parseDeploySearch,
  component: DeployPage,
});
