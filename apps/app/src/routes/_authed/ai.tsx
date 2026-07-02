import { createFileRoute } from '@tanstack/react-router';
import { AiPage } from '@/components/ai/ai-page';

export const Route = createFileRoute('/_authed/ai')({
  component: AiPage,
});
