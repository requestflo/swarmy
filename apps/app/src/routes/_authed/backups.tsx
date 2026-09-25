import { createFileRoute } from '@tanstack/react-router';
import { BackupsPage } from '@/components/backups/backups-page';

/** The one Backups page: where backups go, restore points, and swarmy's own backup. */
export const Route = createFileRoute('/_authed/backups')({
  component: BackupsPage,
});
