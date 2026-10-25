import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { SsoOnlyState } from './sso-only-words';

/** "Members sign in with SSO only": the switch and the providers that can sign people in. Undefined while loading. */
export function useSsoOnly(): SsoOnlyState | undefined {
  const trpc = useTRPC();
  const q = useQuery(trpc.security.ssoOnly.get.queryOptions());
  return q.data as SsoOnlyState | undefined;
}
