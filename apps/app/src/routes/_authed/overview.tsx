import { createFileRoute } from '@tanstack/react-router';
import { OverviewPage } from '@/components/overview/overview-page';

/**
 * Overview — the estate as a sentence, the one thing that needs you, your
 * apps and servers at a glance. First run shows the welcome (Main board).
 */
export const Route = createFileRoute('/_authed/overview')({
  component: OverviewPage,
});
