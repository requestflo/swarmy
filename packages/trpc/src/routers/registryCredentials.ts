import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { REGISTRY_PROVIDERS } from '../services/registry-credentials';
import {
  deleteRegistryCredential,
  listRegistryCredentials,
  testRegistryCredential,
  updateRegistryCredential,
  upsertRegistryCredential,
} from '../services/registry-credentials.service';

const provider = z.enum(REGISTRY_PROVIDERS);
const prefix = z.string().trim().min(1).max(255);
const username = z.string().trim().min(1).max(255);
// Write-only: accepted here, encrypted, never returned by any read.
const secret = z.string().min(1).max(16_384);
const label = z.string().trim().max(120).nullable().optional();
const image = z.string().trim().max(512).optional();

/**
 * Org-level third-party registry credentials (GHCR, Docker Hub, GitLab,
 * ECR/GCR/ACR, generic). Injected automatically on every pull/build by the hub
 * decorator; the token is write-only.
 */
export const registryCredentialsRouter = router({
  list: orgProcedure.query(({ ctx }) => listRegistryCredentials(ctx)),
  /** Create — or rotate the login of an existing prefix. */
  upsert: adminProcedure
    .input(z.object({ prefix, username, secret, provider: provider.optional(), label }))
    .mutation(({ ctx, input }) => upsertRegistryCredential(ctx, input)),
  update: adminProcedure
    .input(z.object({ id: z.string(), username: username.optional(), secret: secret.optional(), provider: provider.optional(), label }))
    .mutation(({ ctx, input }) => updateRegistryCredential(ctx, input)),
  remove: abacProcedure('secret.delete')
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteRegistryCredential(ctx, input.id)),
  /** Test a stored credential (by id) or an unsaved draft; optional manifest HEAD on `image`. */
  test: adminProcedure
    .input(
      z.union([
        z.object({ id: z.string(), image }),
        z.object({ prefix, username, secret, image }),
      ]),
    )
    .mutation(({ ctx, input }) => testRegistryCredential(ctx, input)),
});
