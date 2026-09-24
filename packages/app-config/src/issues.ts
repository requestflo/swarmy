import type { ZodIssue } from 'zod';

/** A located problem in a swarmy.yaml — what the PR check run and editor show. */
export interface ConfigIssue {
  severity: 'error' | 'warning';
  /** Stable machine code, e.g. `binding/unknown-resource`. */
  code: string;
  message: string;
  /** Path into the document, e.g. `['services', 'web', 'env', 'DATABASE_URL']`. */
  path: (string | number)[];
  /** 1-based position of the offending node, when the source text is known. */
  line?: number;
  col?: number;
}

export function issue(
  severity: ConfigIssue['severity'],
  code: string,
  path: ConfigIssue['path'],
  message: string,
): ConfigIssue {
  return { severity, code, path, message };
}

export const hasErrors = (issues: readonly ConfigIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');

/** Flatten a Zod issue; for unions, report the most specific branch's issues. */
export function zodToIssues(i: ZodIssue): ConfigIssue[] {
  if (i.code === 'invalid_union' && i.unionErrors.length) {
    // Prefer the branch that got furthest (deepest path) — e.g. the object form of `build`.
    const branches = i.unionErrors.map((e) => e.issues);
    const best = branches.reduce((a, b) => (depth(b) > depth(a) ? b : a));
    if (depth(best) > i.path.length) return best.flatMap(zodToIssues);
  }
  if (i.code === 'invalid_union_discriminator') {
    return [
      {
        severity: 'error',
        code: 'schema/invalid',
        message: `type must be one of ${i.options.join(', ')}`,
        path: i.path,
      },
    ];
  }
  const message =
    i.code === 'unrecognized_keys'
      ? `unknown key${i.keys.length > 1 ? 's' : ''} ${i.keys.map((k) => `"${k}"`).join(', ')}`
      : i.message;
  const path =
    i.code === 'unrecognized_keys' && i.keys.length === 1
      ? [...i.path, i.keys[0] as string]
      : i.path;
  return [{ severity: 'error', code: 'schema/invalid', message, path }];
}

const depth = (issues: ZodIssue[]): number => Math.max(0, ...issues.map((x) => x.path.length));
