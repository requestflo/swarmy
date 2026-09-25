import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { PROVIDER_LABELS, type ProviderEntry, type SsoProviderEntry } from './access-shared';

export interface SignInMethod {
  id: string;
  label: string;
  kind: 'social' | 'method' | 'sso' | 'password';
  enabled: boolean;
  detail: string;
  /** Controls-depth line (client ids, issuers). */
  tech?: string;
}

/** Every way to sign in here, in the order the sign-in page shows them. */
export function useSignInMethods(): { methods: SignInMethod[] | undefined } {
  const trpc = useTRPC();
  const providers = useQuery(trpc.authConfig.listProviders.queryOptions());
  const sso = useQuery(trpc.sso.list.queryOptions());
  if (!providers.data || !sso.data) return { methods: undefined };
  const ssoRows = (sso.data as SsoProviderEntry[]).map((p) => ({
    id: `sso-${p.id}`,
    label: `Company sign-in (${p.providerId})`,
    kind: 'sso' as const,
    enabled: p.enabled,
    detail: p.domain ? `for anyone @${p.domain}` : 'set up',
    tech: `${p.protocol} · ${p.issuer ?? 'no issuer'} · client ${p.clientId ?? '—'}`,
  }));
  const rest = (providers.data as ProviderEntry[]).map((p) => ({
    id: p.type,
    label: PROVIDER_LABELS[p.type] ?? p.type,
    kind: p.kind,
    enabled: p.enabled,
    detail: p.kind === 'social' ? (p.clientId ? 'set up' : 'not set up') : p.type === 'passkey' ? 'a fingerprint or security key, no password' : 'a one-time link by email',
    tech: p.kind === 'social' ? `client ${p.clientId ?? '—'} · secret ${p.hasSecret ? 'set' : 'unset'} · ${p.callbackUrl}` : p.type,
  }));
  return {
    methods: [...ssoRows, ...rest.filter((r) => r.kind === 'social'), ...rest.filter((r) => r.kind === 'method'), { id: 'password', label: 'Username and password', kind: 'password', enabled: true, detail: 'always on; two-factor optional' }],
  };
}
