/**
 * `ai:` in swarmy.yaml — the app calls the swarmy AI gateway instead of
 * holding provider keys.
 *
 *   ai:
 *     models: [smart, embed]      # the allowlist: aliases, model ids, provider/*
 *     budget: 5/day               # USD per day, shared by the app's keys (optional)
 *     rpm: 120                    # requests/minute per service key (optional)
 *     services: [web, worker]     # default: every service
 *
 * Each bound service gets `OPENAI_BASE_URL` + `ANTHROPIC_BASE_URL` (+
 * `AI_GATEWAY_URL`) in env and its own virtual key as the secret variables
 * `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — Docker secrets exported by the
 * swarmy env shim, never in the spec. Stock OpenAI/Anthropic SDKs work
 * unchanged. The controller wires it on deploy (the `ai` attachment).
 */
import { z } from 'zod';
import { issue, type ConfigIssue } from './issues';
import type { AppConfig } from './schema';

/** Same shape as the gateway's allowlist entries (@swarmy/core AiModelPattern). */
const modelPattern = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9*][A-Za-z0-9._:/@*+-]*$/, 'a model name like smart, gpt-5-mini or groq/*');

/** `5/day`, `$2.50/day`, `5/d` → USD per day (null when malformed). */
export function parseAiBudget(v: string | number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:usd)?\s*\/\s*(day|d|daily)\s*$/i.exec(v);
  if (!m) return null;
  const usd = Number(m[1]);
  return usd > 0 ? usd : null;
}

export const AiSchema = z
  .object({
    models: z.array(modelPattern).min(1, 'list at least one model or alias (e.g. [smart])').max(50),
    budget: z
      .union([z.string(), z.number()])
      .refine((v) => parseAiBudget(v) !== null, 'a daily budget in USD like 5/day')
      .optional(),
    rpm: z.number().int().min(1).max(100_000).optional(),
    services: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();
export type AiInput = z.input<typeof AiSchema>;
export type AiConfig = z.output<typeof AiSchema>;

/** The normalised binding the planner diffs and the controller applies. */
export interface DesiredAi {
  models: string[];
  dailyBudgetUsd: number | null;
  rpm: number | null;
  /** Services bound (sorted). */
  services: string[];
}

export function toDesiredAi(cfg: AppConfig, serviceNames: readonly string[]): DesiredAi | undefined {
  const a = cfg.ai;
  if (!a) return undefined;
  return {
    models: [...new Set(a.models)],
    dailyBudgetUsd: a.budget !== undefined ? parseAiBudget(a.budget) : null,
    rpm: a.rpm ?? null,
    services: [...(a.services ?? serviceNames)].filter((s) => serviceNames.includes(s)).sort(),
  };
}

/** Stable ledger key for a service's binding: re-applies when models/budget/rpm change. */
export function aiAttachmentKey(ai: DesiredAi): string {
  return `ai:${ai.models.join(',')}:${ai.dailyBudgetUsd ?? '-'}:${ai.rpm ?? '-'}`;
}

/** Env names the binding owns — a service's own env must not set them. */
export const AI_BINDING_ENV = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

export function validateAi(cfg: AppConfig): ConfigIssue[] {
  const a = cfg.ai;
  if (!a) return [];
  const out: ConfigIssue[] = [];
  const names = Object.keys(cfg.services);
  for (const [i, s] of (a.services ?? []).entries()) {
    if (!names.includes(s)) out.push(issue('error', 'ai/unknown-service', ['ai', 'services', i], `"${s}" is not a service of this app`));
  }
  const bound = a.services ?? names;
  for (const s of bound) {
    const env = { ...(cfg.env ?? {}), ...(cfg.services[s]?.env ?? {}) };
    for (const k of AI_BINDING_ENV) {
      if (k in env) {
        out.push(
          issue('warning', 'ai/env-overridden', ['services', s, 'env', k], `${k} is set by ai: — the gateway's value wins; remove it from env`),
        );
      }
    }
  }
  return out;
}
