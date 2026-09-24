import { z } from 'zod';
import {
  AiLogsInput,
  AiPlaygroundInput,
  AiSettingsInput,
  AiUsageInput,
  AttachAiInput,
  MintAiKeyInput,
  RemoveAiProviderInput,
  RemoveAiRouteInput,
  SetAiAppModelsInput,
  SetAiProviderInput,
  SetAiRouteInput,
  UpdateAiKeyInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  attachAiToService,
  getProviders,
  getSettings,
  grantStackAccess,
  listKeys,
  listLogs,
  listModels,
  removeRoute,
  runPlayground,
  setAppModels,
  setRoute,
  updateKey,
  listOutlets,
  mintKey,
  removeProvider,
  revokeKey,
  revokeStackAccess,
  setProvider,
  setSettings,
  setStackOutlet,
  stackAccess,
  testProvider,
  usageSummary,
} from '../services/ai.service';

const StackInput = z.object({ stack: z.string().min(1).max(63) });

const GrantStackAccessInput = z.object({
  stack: z.string().min(1).max(63),
  /** Service names in the stack to wire through the gateway (attach flow). */
  services: z.array(z.string().min(1).max(255)).max(50).optional(),
});

const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const SetStackOutletInput = z.object({
  stack: z.string().min(1).max(63),
  /** Bare hostname for the outlet vhost; empty string clears the outlet. */
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .refine((d) => d === '' || HOSTNAME_RE.test(d), 'enter a bare domain like ai.example.com'),
});

/**
 * AI gateway control plane (slice F5) — providers (keys vault-encrypted,
 * write-only), virtual keys (revealed once), usage/cost aggregates, request
 * log and settings. The data plane lives in apps/api/src/ai-gateway.ts.
 */
export const aiGatewayRouter = router({
  /** Configured upstream providers + the gateway base URL (no secrets). */
  providers: orgProcedure.query(({ ctx }) => getProviders(ctx)),

  /** Save/update a provider. The API key is encrypted and never returned. */
  setProvider: orgProcedure
    .input(SetAiProviderInput)
    .mutation(({ ctx, input }) => setProvider(ctx, input)),

  /** Remove a provider (and its stored key). */
  removeProvider: orgProcedure
    .input(RemoveAiProviderInput)
    .mutation(({ ctx, input }) => removeProvider(ctx, input.kind)),

  /** One cheap upstream request to verify the stored key works. */
  testProvider: orgProcedure
    .input(RemoveAiProviderInput)
    .mutation(({ ctx, input }) => testProvider(ctx, input.kind)),

  /** Virtual keys with 30-day usage. Key values are never returned. */
  keys: orgProcedure.query(({ ctx }) => listKeys(ctx)),

  /** Mint a virtual key — the plaintext is returned ONCE, then hash-only. */
  mintKey: orgProcedure.input(MintAiKeyInput).mutation(({ ctx, input }) => mintKey(ctx, input)),

  /** Edit a key's model allowlist / limits in place (no rotation). */
  updateKey: orgProcedure.input(UpdateAiKeyInput).mutation(({ ctx, input }) => updateKey(ctx, input)),

  /** Catalogue + routes (aliases) + per-app allowlists, as the gateway resolves them. */
  models: orgProcedure.query(({ ctx }) => listModels(ctx)),

  /** Create/replace a route: fallback order or weighted load-balancing across providers. */
  setRoute: orgProcedure.input(SetAiRouteInput).mutation(({ ctx, input }) => setRoute(ctx, input)),
  removeRoute: orgProcedure
    .input(RemoveAiRouteInput)
    .mutation(({ ctx, input }) => removeRoute(ctx, input.name)),

  /** Per-app model allowlist (applies to every key minted for the app). */
  setAppModels: orgProcedure
    .input(SetAiAppModelsInput)
    .mutation(({ ctx, input }) => setAppModels(ctx, input)),

  /** Try a model under one key's limits (metered + traced like any call). */
  playground: orgProcedure
    .input(AiPlaygroundInput)
    .mutation(({ ctx, input }) => runPlayground(ctx, input)),

  /** Disable a key (the gateway answers 403 for it immediately). */
  revokeKey: orgProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => revokeKey(ctx, input.id)),

  /** Usage aggregates: per-day buckets + per-model/per-key breakdowns. */
  usage: orgProcedure.input(AiUsageInput).query(({ ctx, input }) => usageSummary(ctx, input)),

  /** Recent request log rows (written only when the audit toggle is on). */
  logs: orgProcedure.input(AiLogsInput).query(({ ctx, input }) => listLogs(ctx, input)),

  /** Gateway toggles: request audit log + exact-match response cache. */
  settings: orgProcedure.query(({ ctx }) => getSettings(ctx)),
  setSettings: orgProcedure
    .input(AiSettingsInput)
    .mutation(({ ctx, input }) => setSettings(ctx, input)),

  /** Wire an app: AI_GATEWAY_URL env + a per-app key in a Docker secret. */
  attachToService: orgProcedure
    .input(AttachAiInput)
    .mutation(({ ctx, input }) => attachAiToService(ctx, input)),

  /** One stack's grant: stack-tagged key + attached services + outlet domain. */
  stackAccess: orgProcedure
    .input(StackInput)
    .query(({ ctx, input }) => stackAccess(ctx, input.stack)),

  /** Grant a stack access: mint its key (revealed ONCE) + wire chosen services. */
  grantStackAccess: orgProcedure
    .input(GrantStackAccessInput)
    .mutation(({ ctx, input }) => grantStackAccess(ctx, input)),

  /** Kill the grant: disable the stack key and every per-service key. */
  revokeStackAccess: orgProcedure
    .input(StackInput)
    .mutation(({ ctx, input }) => revokeStackAccess(ctx, input.stack)),

  /** Point a public outlet domain at the stack's gateway (empty clears). */
  setStackOutlet: orgProcedure
    .input(SetStackOutletInput)
    .mutation(({ ctx, input }) => setStackOutlet(ctx, input)),

  /** Every stack outlet — the edge renders one gateway vhost per entry. */
  listOutlets: orgProcedure.query(({ ctx }) => listOutlets(ctx)),
});
