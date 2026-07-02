import { createFileRoute } from '@tanstack/react-router';
import { SecretsPage } from '@/components/secretsmgr/secrets-page';

export const Route = createFileRoute('/_authed/secrets')({
  component: SecretsPage,
});
