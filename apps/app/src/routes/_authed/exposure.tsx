import { createFileRoute } from '@tanstack/react-router';
import { ExposurePage } from '@/components/exposure/exposure-page';

export const Route = createFileRoute('/_authed/exposure')({
  component: ExposurePage,
});
