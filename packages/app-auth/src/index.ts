/**
 * @swarmy/app-auth — server side. `getSession(req)` for apps behind swarmy
 * auth (Protect my app, or `auth:` in swarmy.yaml), plus the dependency-free
 * JWT/JWKS verifier it is built on. Browser helpers: `@swarmy/app-auth/client`.
 */
export {
  getSession,
  readHeader,
  requestHost,
  resetSessionCaches,
  APP_AUTH_BASE_PATH,
  DEFAULT_SWARMY_JWKS_URL,
  SWARMY_JWT_HEADER,
  type GetSessionOptions,
  type RequestLike,
  type SessionUser,
  type SwarmySession,
} from './session';
export {
  base64UrlDecode,
  base64UrlEncode,
  decodeJwt,
  remoteJwks,
  verifyJwt,
  verifyWithJwks,
  JwtError,
  type Jwk,
  type JwtClaims,
  type JwtHeader,
  type RemoteJwks,
  type VerifyOptions,
} from './jwt';
