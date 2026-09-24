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
