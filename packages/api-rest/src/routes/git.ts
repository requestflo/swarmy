import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  badRequest,
  browserFlowRequired,
  createConnection,
  getConnection,
  getRepo,
  linkRepo,
  listConnections,
  listProviderBranches,
  listProviderRepos,
  listRepos,
  removeConnection,
  removeRepo,
  type CreateConnectionInput,
  type GitConnectionView,
  type GitRepoView,
  type LinkedRepoView,
  type ProviderRepo,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireAdmin, requireScope } from '../middleware';
import { ProblemDto, listEnvelope } from '../dto';
import { run } from '../respond';

/**
 * Git provider connections + linked repos (`/v1/git/*`) — the REST twin of the
 * `gitConnections` tRPC router (and `cicd.listRepos/removeRepo`), riding the
 * SAME `git-connections.service` / `cicd.service` functions.
 *
 * Only the NON-browser connection kinds can be created here: a GitLab personal/
 * project/group access token, or a Gitea / generic git host (optional token).
 * A GitHub App install and GitLab OAuth need an interactive browser round-trip,
 * so they are refused with `422 BROWSER_FLOW_REQUIRED` — connect those in the
 * dashboard (Settings → Git), then reference the connection by id.
 *
 * Secrets: provider tokens are WRITE-ONLY (accepted on create, vault-encrypted,
 * never returned). Linking a repo returns the generic webhook secret and the
 * deploy-key public half exactly ONCE — no read returns them again.
 */

const Kind = z.enum(['github', 'gitlab', 'gitea', 'generic']).openapi('GitConnectionKind', {
  description: 'Git provider kind. Open enum — new kinds may be added.',
});

const GitConnectionDto = z
  .object({
    id: z.string(),
    kind: Kind,
    display_name: z.string(),
    base_url: z.string().openapi({ example: 'https://gitlab.com' }),
    account: z.string().nullable().openapi({ description: 'Provider account the credential acts as, when known.' }),
    status: z.string().openapi({ description: '`active` or `pending` (an OAuth grant not yet completed).' }),
    repo_count: z.number().int(),
    created_at: z.string(),
  })
  .openapi('GitConnection');

const httpUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

const CreateGitConnectionBody = z
  .object({
    kind: Kind,
    mode: z.enum(['token', 'oauth']).optional().openapi({
      description:
        'GitLab only. `token` (default) — only mode available over REST; `oauth` needs a browser and is refused.',
    }),
    base_url: httpUrl.optional().openapi({
      description: 'Provider base URL. Defaults to https://gitlab.com for GitLab; required for gitea/generic.',
    }),
    display_name: z.string().trim().min(1).max(80).optional().openapi({ description: 'gitea/generic only.' }),
    token: z.string().min(1).max(500).optional().openapi({
      description: 'Access token. Required for GitLab (≥ 8 chars), optional for gitea/generic. Write-only; never returned.',
    }),
    token_user: z.string().min(1).max(100).optional().openapi({
      description: 'HTTP basic username the token is sent as (gitea/generic; default `git`).',
    }),
  })
  .openapi('CreateGitConnectionBody');

const ProviderRepoDto = z
  .object({
    id: z.string(),
    full_name: z.string(),
    clone_url: z.string(),
    html_url: z.string(),
    default_branch: z.string(),
    private: z.boolean(),
  })
  .openapi('GitProviderRepo');

const ProviderBranchDto = z.object({ name: z.string(), sha: z.string() }).openapi('GitProviderBranch');

const GitRepoDto = z
  .object({
    id: z.string(),
    kind: Kind,
    url: z.string(),
    branch: z.string(),
    config_path: z.string(),
    connection_id: z.string().nullable(),
    full_name: z.string().nullable(),
    autodeploy: z.boolean(),
    service_id: z.string().nullable(),
    has_token: z.boolean(),
    created_at: z.string(),
  })
  .openapi('GitRepo');

const branchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'invalid branch name');
const configPath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(\.\/)?[A-Za-z0-9._/@+-]*swarmy\.ya?ml$/, 'must point at a swarmy.yaml')
  .refine((p) => !p.split('/').includes('..'), 'no .. segments');

// Inline for the same reason (optional nested body object); SDKs name it GitRepoRef.
const GitRepoRefDto = z
  .object({
    id: z.string().min(1),
    full_name: z.string().min(1),
    clone_url: z.string().min(1),
  })
  .openapi({ description: 'A repo from `GET /git/connections/{id}/repos`.' });

const LinkGitRepoBody = z
  .object({
    connection_id: z.string().min(1).optional(),
    repo: GitRepoRefDto.optional().openapi({ description: 'A picked provider repo. Give exactly one of `repo` or `url`.' }),
    url: z.string().min(1).max(500).optional().openapi({ description: 'Raw clone URL (generic git). Give exactly one of `repo` or `url`.' }),
    branch: branchName,
    config_path: configPath.optional().openapi({ description: 'Path of the swarmy.yaml to apply (default `swarmy.yaml`).' }),
    deploy_key: z.boolean().optional().openapi({
      description: 'Mint an ed25519 deploy key (SSH remotes). Its public half is returned once.',
    }),
  })
  .openapi('LinkGitRepoBody');

const GitRepoWebhookDto = z
  .object({
    url: z.string(),
    secret: z.string().openapi({ description: 'HMAC secret. WRITE-ONCE: returned only by this response.' }),
  });
// ↑ Inline (not a named component): a nullable $ref loses `nullable` in the
// emitted spec. The SDK generator names it GitRepoWebhook.

const LinkedGitRepoDto = z
  .object({
    id: z.string(),
    url: z.string(),
    branch: z.string(),
    config_path: z.string(),
    full_name: z.string().nullable(),
    webhook: GitRepoWebhookDto.nullable().openapi({
      description:
        'Webhook to configure on the git host when swarmy could not register it itself (null for GitHub App / auto-registered GitLab hooks). WRITE-ONCE: never returned again.',
    }),
    deploy_key_public: z.string().nullable().openapi({
      description: 'Public deploy key to add to the git host. WRITE-ONCE: never returned again.',
    }),
  })
  .openapi('LinkedGitRepo');

const RemovedDto = z.object({ id: z.string(), removed: z.literal(true) }).openapi('GitRemoved');

const GitConnectionList = listEnvelope(GitConnectionDto, 'GitConnectionList');
const ProviderRepoList = listEnvelope(ProviderRepoDto, 'GitProviderRepoList');
const ProviderBranchList = listEnvelope(ProviderBranchDto, 'GitProviderBranchList');
const GitRepoList = listEnvelope(GitRepoDto, 'GitRepoList');

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({ content: { 'application/json': { schema } } });
const TAG = 'Git';

// ── mappers (camel → snake; the only place the translation happens) ─────────

export function gitConnectionToDto(v: GitConnectionView): z.infer<typeof GitConnectionDto> {
  return {
    id: v.id,
    kind: v.kind,
    display_name: v.displayName,
    base_url: v.baseUrl,
    account: v.account,
    status: v.status,
    repo_count: v.repoCount,
    created_at: v.createdAt,
  };
}

export function providerRepoToDto(r: ProviderRepo): z.infer<typeof ProviderRepoDto> {
  return {
    id: r.id,
    full_name: r.fullName,
    clone_url: r.cloneUrl,
    html_url: r.htmlUrl,
    default_branch: r.defaultBranch,
    private: r.private,
  };
}

export function gitRepoToDto(v: GitRepoView): z.infer<typeof GitRepoDto> {
  return {
    id: v.id,
    kind: v.kind,
    url: v.url,
    branch: v.branch,
    config_path: v.configPath,
    connection_id: v.connectionId,
    full_name: v.fullName,
    autodeploy: v.autodeploy,
    service_id: v.serviceId,
    has_token: v.hasToken,
    created_at: v.createdAt,
  };
}

export function linkedRepoToDto(v: LinkedRepoView): z.infer<typeof LinkedGitRepoDto> {
  return {
    id: v.id,
    url: v.url,
    branch: v.branch,
    config_path: v.configPath,
    full_name: v.fullName,
    webhook: v.webhook,
    deploy_key_public: v.deployKeyPublic,
  };
}

/**
 * Public create body → the service's `CreateConnectionInput`. Refuses the
 * browser-only kinds; everything else is validated by the service exactly as
 * for the dashboard (the GitLab token is verified against the provider).
 */
export function toCreateConnectionInput(b: z.infer<typeof CreateGitConnectionBody>): CreateConnectionInput {
  if (b.kind === 'github') {
    throw browserFlowRequired(
      'GitHub connections are made by installing the swarmy GitHub App, which needs a browser — connect GitHub in the dashboard, then use the connection id here.',
    );
  }
  if (b.kind === 'gitlab') {
    if (b.mode === 'oauth') {
      throw browserFlowRequired(
        'GitLab OAuth needs a browser round-trip — connect it in the dashboard, or create a token connection (mode "token") here.',
      );
    }
    if (!b.token || b.token.length < 8) throw badRequest('a GitLab connection needs `token` (at least 8 characters)');
    return { kind: 'gitlab', mode: 'token', token: b.token, ...(b.base_url ? { baseUrl: b.base_url } : {}) };
  }
  if (b.mode) throw badRequest('`mode` applies to GitLab connections only');
  if (!b.base_url) throw badRequest(`a ${b.kind} connection needs \`base_url\``);
  return {
    kind: b.kind,
    baseUrl: b.base_url,
    ...(b.display_name ? { displayName: b.display_name } : {}),
    ...(b.token ? { token: b.token } : {}),
    ...(b.token_user ? { tokenUser: b.token_user } : {}),
  };
}

export function registerGitRoutes(app: OpenAPIHono<RestEnv>): void {
  // ── connections ────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'get',
      path: '/git/connections',
      tags: [TAG],
      summary: 'List git provider connections (credentials never returned)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: GitConnectionList } }, description: 'Connections' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listConnections(c.get('orgCtx'))).map(gitConnectionToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/git/connections',
      tags: [TAG],
      summary: 'Connect a GitLab (token), Gitea or generic git host',
      description:
        'GitHub App and GitLab OAuth connections need a browser and are refused with `422` (`swarmy_code: BROWSER_FLOW_REQUIRED`) — make those in the dashboard. A GitLab token is verified against the provider before it is saved. Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { body: jsonBody(CreateGitConnectionBody) },
      responses: {
        201: { content: { 'application/json': { schema: GitConnectionDto } }, description: 'Connected' },
        400: problemRes,
        403: problemRes,
        412: problemRes,
        422: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const input = toCreateConnectionInput(c.req.valid('json'));
          return gitConnectionToDto((await createConnection(c.get('orgCtx'), input)).connection);
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/git/connections/{id}',
      tags: [TAG],
      summary: 'Get a git provider connection',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: GitConnectionDto } }, description: 'Connection' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => gitConnectionToDto(await getConnection(c.get('orgCtx'), c.req.param('id')))),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/git/connections/{id}',
      tags: [TAG],
      summary: 'Remove a git provider connection',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('cicd.remove')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeConnection(c.get('orgCtx'), c.req.param('id'))),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/git/connections/{id}/repos',
      tags: [TAG],
      summary: "List repositories the connection can see (the provider's repo picker)",
      description: 'Generic git hosts have no listing API and return an empty list — link them by URL.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: {
        params: idParam,
        query: z.object({
          search: z.string().max(100).optional().openapi({ param: { name: 'search', in: 'query' } }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: ProviderRepoList } }, description: 'Repositories' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => ({
        data: (
          await listProviderRepos(c.get('orgCtx'), {
            connectionId: c.req.param('id'),
            search: c.req.valid('query').search,
          })
        ).map(providerRepoToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/git/connections/{id}/branches',
      tags: [TAG],
      summary: 'List branches of a repository visible to the connection',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: {
        params: idParam,
        query: z.object({
          repo: z
            .string()
            .min(1)
            .max(300)
            .openapi({
              param: { name: 'repo', in: 'query' },
              description: 'Provider repo: `owner/name` (GitHub) or project id/path (GitLab).',
            }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: ProviderBranchList } }, description: 'Branches' },
        400: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => ({
        data: await listProviderBranches(c.get('orgCtx'), {
          connectionId: c.req.param('id'),
          repo: c.req.valid('query').repo,
        }),
        next_cursor: null,
      })),
  );

  // ── linked repos ───────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'get',
      path: '/git/repos',
      tags: [TAG],
      summary: 'List linked repositories (secrets never returned)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: GitRepoList } }, description: 'Repositories' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listRepos(c.get('orgCtx'))).map(gitRepoToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/git/repos',
      tags: [TAG],
      summary: 'Link a repository (branch + swarmy.yaml path) as an app binding',
      description:
        'Give either a picked provider `repo` (with its `connection_id`) or a raw `url`. The response carries the webhook secret and deploy-key public half ONCE — store them; no read returns them again. Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { body: jsonBody(LinkGitRepoBody) },
      responses: {
        201: { content: { 'application/json': { schema: LinkedGitRepoDto } }, description: 'Linked' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          if (Boolean(b.repo) === Boolean(b.url)) throw badRequest('give either a picked `repo` or a `url`');
          return linkedRepoToDto(
            await linkRepo(c.get('orgCtx'), {
              ...(b.connection_id ? { connectionId: b.connection_id } : {}),
              ...(b.repo ? { repo: { id: b.repo.id, fullName: b.repo.full_name, cloneUrl: b.repo.clone_url } } : {}),
              ...(b.url ? { url: b.url } : {}),
              branch: b.branch,
              ...(b.config_path ? { configPath: b.config_path } : {}),
              ...(b.deploy_key !== undefined ? { deployKey: b.deploy_key } : {}),
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/git/repos/{id}',
      tags: [TAG],
      summary: 'Get a linked repository',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: GitRepoDto } }, description: 'Repository' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => gitRepoToDto(await getRepo(c.get('orgCtx'), c.req.param('id')))),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/git/repos/{id}',
      tags: [TAG],
      summary: 'Unlink a repository',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('cicd.remove')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeRepo(c.get('orgCtx'), c.req.param('id'))),
  );
}
