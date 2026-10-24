import * as React from 'react';
import type { ConfigIssue } from '@swarmy/app-config';
import { Button, cn } from '@swarmy/ui';
import { Section, Tech, TONE_DOT } from '@/components/calm';
import type { Fix } from './fixes';

/**
 * Every problem the parser found, by line: the line number moves the
 * cursor there, Fix applies the answer the problem names. Warnings don't
 * stop a deploy; errors do — the controller's check run says the same.
 */
export function ProblemsList({
  issues,
  fixOf,
  onJump,
  onFix,
}: {
  issues: readonly ConfigIssue[];
  fixOf: (i: ConfigIssue) => Fix | null;
  onJump: (line: number) => void;
  onFix: (fix: Fix) => void;
}): React.JSX.Element | null {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  const count = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : null, warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  return (
    <Section title={errors ? 'Fix these before you push' : 'Worth a look'} count={count} flush>
      <ul className="flex flex-col">
        {issues.map((i, k) => {
          const fix = fixOf(i);
          return (
            <li key={`${i.code}:${i.line ?? 0}:${k}`} className="border-border flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', i.severity === 'error' ? TONE_DOT.bad : TONE_DOT.warn)} />
              {i.line ? (
                <button
                  type="button"
                  onClick={() => onJump(i.line ?? 1)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 min-w-12 rounded font-mono text-[12px] outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
                  aria-label={`Go to line ${i.line}`}
                >
                  line {i.line}
                </button>
              ) : (
                <span className="text-muted-foreground min-w-12 font-mono text-[12px]">file</span>
              )}
              <span className="min-w-0 flex-1 text-[13.5px]">{i.message}</span>
              {fix ? (
                <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={() => onFix(fix)}>
                  Fix: <span className="font-mono">{fix.to}</span>
                </Button>
              ) : null}
              <Tech className="basis-full pl-5">
                {i.code}
                {i.path.length ? ` · ${i.path.join('.')}` : ''}
              </Tech>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
