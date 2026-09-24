/**
 * The official TypeScript SDK (`sdks/typescript`, standalone by design — not a
 * workspace package), imported by path so the CLI and MCP server speak the
 * public REST API through the same client users get.
 */
export { SwarmyClient, SwarmyApiError, sseData } from '../../../sdks/typescript/src/index';
export type * from '../../../sdks/typescript/src/models';
export type { SwarmyClientOptions, FetchLike } from '../../../sdks/typescript/src/index';
