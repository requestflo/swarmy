import { createFileRoute } from '@tanstack/react-router';
import { GuardrailsPage } from '@/components/guardrails/guardrails-page';

export const Route = createFileRoute('/_authed/governance')({
  component: GuardrailsPage,
});
