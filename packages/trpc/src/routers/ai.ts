import { z } from 'zod';
import {
  AiLogsInput,
  AiSettingsInput,
  AiUsageInput,
  AttachAiInput,
  MintAiKeyInput,
  RemoveAiProviderInput,
  SetAiProviderInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  attachAiToService,
  getProviders,
  getSettings,
  listKeys,
  listLogs,
  mintKey,
  removeProvider,
  revokeKey,
  setProvider,
  setSettings,
  testProvider,
  usageSummary,
} from '../services/ai.service';

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
});
