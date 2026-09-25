import { createFileRoute } from '@tanstack/react-router';
import { ApiKeysPage } from '@/components/apikeys/api-keys-page';

export const Route = createFileRoute('/_authed/settings_/api-keys')({
  component: ApiKeysPage,
});
