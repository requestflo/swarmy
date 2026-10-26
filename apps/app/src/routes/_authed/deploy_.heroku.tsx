import { createFileRoute } from '@tanstack/react-router';
import { HerokuImportPage } from '@/components/heroku/heroku-import-page';

/** Deploy › Import from Heroku: read the app (token or pasted files), review the plan, Deploy, copy the data. */
export const Route = createFileRoute('/_authed/deploy_/heroku')({
  component: HerokuImportPage,
});
