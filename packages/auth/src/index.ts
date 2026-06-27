export { auth, buildAuth, AuthRegistry, authRegistry } from './server';
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
