/**
 * `@swarmy/trpc/devx` — the service surface of the developer CLI + MCP server
 * (REST routes in @swarmy/api-rest, the device-login and /mcp endpoints in
 * apps/api). A separate entry so these land without touching the main barrel.
 */
export {
  resolveOrgContextFromBearer,
  apiScopesFromOAuth,
  type ResolveBearerDeps,
  type VerifiedBearerToken,
} from './apiKeyContext';
export {
  readServiceEnv,
  patchServiceEnv,
  serviceLogLines,
  collectServiceLogs,
  type ServiceEnvView,
  type ServiceEnvVarView,
  type PatchServiceEnvInput,
} from './services/devx.service';
export {
  startDeviceAuthorization,
  pollDeviceAuthorization,
  describeDeviceAuthorization,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  normalizeUserCode,
  normalizeScopes,
  grantableScopes,
  CLI_SCOPES,
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_S,
  type DeviceStart,
  type DevicePoll,
  type DeviceRequestView,
} from './services/cli-device.service';
export { getDeployStatus, noteStackDeployAccepted } from './services/deployment.service';
export { createAppPreview } from './services/apps.service';
export { enableForStack, stackTelemetryEnabled } from './services/observability.service';
export { stackStatus as errorsStackStatus, type StackErrorsStatus } from './services/errors/errors.service';
export { rotateKey as rotateErrorsKey, type ErrorProjectView } from './services/errors/projects';
