/**
 * swarmy.yaml text → a validated `AppConfig` + located issues. The one entry
 * point the controller (webhook → fetch file at commit), the PR check run, and
 * the dashboard's editor all call, so they report identical errors with
 * identical line numbers.
 */
import { LineCounter, isNode, parseDocument } from 'yaml';
import { hasErrors, zodToIssues, type ConfigIssue } from './issues';
import { AppConfigSchema, type AppConfig } from './schema';
import { validateConfig } from './validate';

export const CONFIG_FILENAMES = ['swarmy.yaml', 'swarmy.yml'] as const;
/** swarmy.yaml is small by design; anything bigger is a mistake (or an attack). */
export const MAX_CONFIG_BYTES = 256 * 1024;

export interface ParseResult {
  /** Present when there are no errors (warnings allowed). */
  config?: AppConfig;
  issues: ConfigIssue[];
}

export function parseAppConfig(text: string): ParseResult {
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    return {
      issues: [
        {
          severity: 'error',
          code: 'yaml/too-large',
          message: `swarmy.yaml is over ${MAX_CONFIG_BYTES / 1024}KB`,
          path: [],
        },
      ],
    };
  }
  const lineCounter = new LineCounter();
  // uniqueKeys: a duplicated key is an error, not a silent last-wins.
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: false });

  const yamlIssues: ConfigIssue[] = [...doc.errors, ...doc.warnings].map((e) => {
    const pos = lineCounter.linePos(e.pos[0]);
    return {
      severity: doc.errors.includes(e as never) ? 'error' : 'warning',
      code: `yaml/${e.code.toLowerCase().replace(/_/g, '-')}`,
      message: e.message.split('\n')[0] ?? e.message,
      path: [],
      line: pos.line,
      col: pos.col,
    };
  });
  if (doc.errors.length) return { issues: yamlIssues };

  const locate = (path: (string | number)[]): { line?: number; col?: number } => {
    // Walk up until a node exists (a missing key points at its parent).
    for (let p = [...path]; ; p = p.slice(0, -1)) {
      const node = p.length ? doc.getIn(p, true) : doc.contents;
      if (isNode(node) && node.range) {
        const { line, col } = lineCounter.linePos(node.range[0]);
        return { line, col };
      }
      if (!p.length) return {};
    }
  };

  const raw: unknown = doc.toJS({ maxAliasCount: 50 });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      issues: [
        ...yamlIssues,
        {
          severity: 'error',
          code: 'config/not-a-map',
          message: 'swarmy.yaml must be a mapping (version:, app:, services: …)',
          path: [],
        },
      ],
    };
  }

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .flatMap((i) => zodToIssues(i))
      .map((i) => ({ ...i, ...locate(i.path) }));
    return { issues: [...yamlIssues, ...dedupe(issues)] };
  }

  const semantic = validateConfig(parsed.data).map((i) => ({ ...i, ...locate(i.path) }));
  const issues = [...yamlIssues, ...semantic];
  return hasErrors(issues) ? { issues } : { config: parsed.data, issues };
}

function dedupe(issues: ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.path.join('.')}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
