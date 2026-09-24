import type { BlueprintCategory, BlueprintOptionView } from '@swarmy/core';

/**
 * One-click app templates — each one IS a swarmy.yaml (v1, `@swarmy/app-config`)
 * plus a small metadata header. "Deploy template" and (later) "deploy from git"
 * therefore share one schema, one validator and one planner; the controller's
 * blueprint executor compiles the normalised `DesiredApp` into its existing
 * plan steps (managed Postgres / cache, generated secrets, compose deploy,
 * ingress route) until the git-apps applier lands.
 *
 * Authoring rules (enforced by `catalog.test.ts` in this package and the
 * compose-pipeline test in `@swarmy/trpc`):
 *  - Images are pinned to an exact upstream release (never `latest`).
 *  - Prefer swarmy-native data: `resources: { db: postgres }` / `cache` instead of
 *    bundling a database container, so the template inherits backups, PITR and
 *    HA. Bundle an engine ONLY when swarmy has no managed equivalent (MySQL,
 *    MongoDB, ClickHouse) or the app needs a patched build (Immich's vector PG).
 *  - Credentials never live in the yaml: generate them (`generate`) and bind
 *    them (`${{ secrets.x }}` → env, or `secrets: [x]` + `FOO_FILE:
 *    /run/secrets/x` → a mounted Docker secret — prefer the file when the image
 *    supports `_FILE`).
 *  - Every service sets `memory` (1 GB-node budget) and, where the image has a
 *    probe tool, a healthcheck. `healthcheck.path` compiles to a wget-or-curl
 *    probe, so use it only for images that ship one of them; otherwise use
 *    `command`, or rely on the image's own HEALTHCHECK (`imageHealthcheck`).
 *  - No `domains:` in the yaml — the deploy's domain param (or the auto URL)
 *    routes to `primary`; use `${{ app.url }}` / `${{ app.domain }}` for env.
 *  - No `build:` and no `release:` (image-only; the blueprint path has no
 *    release step yet).
 *  - Param placeholders `[[opt.<key>]]` are substituted before parsing.
 */

/** A secret generated at deploy time (family `<stack>-<name>`, write-only). */
export interface GeneratedSecret {
  /** hex = [0-9a-f], alnum = [A-Za-z0-9], base64url = URL-safe base64. */
  format: 'hex' | 'alnum' | 'base64url';
  /** Output length in characters. */
  length: number;
}

export interface AppTemplate {
  /** Catalog slug (gallery id + deploy id). */
  id: string;
  name: string;
  /** One line, sentence case, no trailing period. */
  tagline: string;
  category: BlueprintCategory;
  /** simple-icons slug (https://simpleicons.org) or `lucide:<name>`. */
  icon: string;
  website: string;
  /** Upstream app version the pinned image deploys (display). */
  version: string;
  /** The swarmy.yaml body. `app:` is replaced with the stack name. */
  yaml: string;
  /** Service that receives the route/URL (default: the only one with `port`). */
  primary?: string;
  /** Secrets generated on deploy, bound as `${{ secrets.<name> }}`. */
  generate?: Record<string, GeneratedSecret>;
  /**
   * One-time notes shown after deploy (bindings like `${{ secrets.admin-password }}`
   * are resolved) — e.g. a generated admin login. Never persisted.
   */
  reveal?: string[];
  /** First-login steps (static text), shown after deploy and on the card. */
  postDeploy: string[];
  /** Wizard knobs; substituted into the yaml as `[[opt.<key>]]`. */
  options?: BlueprintOptionView[];
  /** Services whose image ships its own HEALTHCHECK (so the yaml sets none). */
  imageHealthcheck?: string[];
  /**
   * Services whose image has no `/bin/sh` (FROM scratch / distroless). A
   * generated secret bound as a whole env value is normally exported by
   * swarmy's secret-env shim (the value never enters the spec); the shim needs
   * a shell, so for these services it is rendered into env instead. Prefer
   * `secrets:` + a `_FILE` var when the image supports one.
   */
  noShell?: string[];
  /**
   * `private`: never routed publicly (no domain, no auto address). For
   * unauthenticated APIs (Ollama, Apprise) that other apps reach in-swarm via
   * `connect`. `<internal>` in postDeploy renders the in-swarm URL.
   */
  exposure?: 'private';
  /** Why it is heavy for a 1 GB node (auto-flagged above the budget anyway). */
  heavyReason?: string;
  /** Honest caveats: bundled engines, missing features, etc. */
  notes?: string[];
  /** Provenance. Imported templates keep the Apache-2.0 attribution. */
  source?: { kind: 'coolify'; path: string };
}

/** Memory budget for a 1 GB node after the OS + swarmy agent (MB). */
export const ONE_GB_NODE_BUDGET_MB = 768;
/** Memory the managed services add at size `s` (estimates for the badge). */
export const MANAGED_POSTGRES_MB = 256;
export const MANAGED_CACHE_OVERHEAD_MB = 64;
