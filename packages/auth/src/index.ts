export { auth, buildAuth, AuthRegistry, authRegistry, AUTH_RATE_LIMIT_RULES } from './server';
export {
  CLIENT_IP_HEADER,
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  resolveClientIp,
  withClientIp,
  isTrustedProxy,
} from './client-ip';
export type { TrustedProxies } from './client-ip';
export type { Auth, Session, AuthUser, SendMagicLink, BuildAuthOptions, ExtraPlugin } from './server';
export {
  loadAuthConfig,
  loadSsoProviders,
  resolveSsoProviderByEmail,
  SOCIAL_PROVIDERS,
  AUTH_METHODS,
  isSocialProvider,
  isAuthMethod,
} from './config';
export type {
  ResolvedAuthConfig,
  ResolvedSocialProvider,
  ResolvedSsoProvider,
  SocialProviderId,
  AuthMethodId,
  ProviderStatus,
} from './config';
