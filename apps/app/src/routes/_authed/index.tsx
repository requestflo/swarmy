import { createFileRoute } from '@tanstack/react-router';
import { ApplicationsCanvas } from '@/components/canvas/applications-canvas';

/**
 * The Applications plane — the home. A Railway-style canvas of every service you
 * run, arrangeable by drag (visual only), each card showing status, replica
 * health, and where it runs. The cluster itself lives on the Infrastructure
 * plane (/nodes).
 */
export const Route = createFileRoute('/_authed/')({
  component: ApplicationsCanvas,
});
