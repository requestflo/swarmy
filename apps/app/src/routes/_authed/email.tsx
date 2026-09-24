import { createFileRoute } from '@tanstack/react-router';
import { EmailPage } from '@/components/email/email-page';

export const Route = createFileRoute('/_authed/email')({
  component: EmailPage,
});
