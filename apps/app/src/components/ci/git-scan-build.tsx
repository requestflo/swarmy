import * as React from 'react';
import { cn, Input } from '@swarmy/ui';
import type { BuildFacts } from './git-scan-types';
import type { BuildForm } from './use-scan-draft';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-10 flex-col gap-1 border-b py-2 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
      <span className="text-muted-foreground w-36 shrink-0 text-[12.5px] font-semibold">{label}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {children}
        {hint ? <span className="text-muted-foreground font-mono text-[11px]">{hint}</span> : null}
      </span>
    </div>
  );
}

const mono = 'h-8 font-mono text-[12.5px]';

/**
 * Build · advanced (Controls depth): swarmy.yaml's `build:` keys — path,
 * dockerfile, target, args, watch. Blank keeps the schema default, so the
 * file only grows when you ask it to.
 */
export function GitScanBuild({
  dir,
  facts,
  form,
  onChange,
}: {
  dir: string;
  facts: BuildFacts;
  form: BuildForm;
  onChange: (k: keyof BuildForm, v: string) => void;
}): React.JSX.Element {
  const path = form.path.trim() || dir || '.';
  const argHint = facts.args.length ? `ARG in the Dockerfile: ${facts.args.map((a) => a.name).join(', ')}` : undefined;
  return (
    <section aria-label="Build · advanced" className="flex flex-col rounded-xl border px-4 py-2">
      <span className="calm-eyebrow pt-1 pb-1">Build · advanced</span>
      <Field label="Build path" hint="build.path — the folder sent to the builder">
        <Input value={form.path} onChange={(e) => onChange('path', e.target.value)}
          aria-label="Build path" placeholder={dir || '.'} className={mono} />
      </Field>
      <Field label="Dockerfile" hint={facts.dockerfile ? `found ${facts.dockerfile}` : 'none found — swarmy builds it zero-config (Railpack)'}>
        <Input value={form.dockerfile} onChange={(e) => onChange('dockerfile', e.target.value)}
          aria-label="Dockerfile" placeholder="Dockerfile" className={mono} />
      </Field>
      <Field label="Target stage" hint={facts.stages.length ? `${facts.stages.length} stage${facts.stages.length === 1 ? '' : 's'} found · last = the final stage` : 'no named stages'}>
        <span role="radiogroup" aria-label="Target stage" className="flex flex-wrap gap-1">
          {['', ...facts.stages].map((s) => (
            <button
              key={s || 'last'}
              type="button"
              role="radio"
              aria-checked={form.target === s}
              onClick={() => onChange('target', s)}
              className={cn(
                'h-7 rounded-lg border px-2.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
                form.target === s ? 'bg-accent border-foreground/30 font-semibold' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {s || 'last'}
            </button>
          ))}
        </span>
      </Field>
      <Field label="Build args" hint={argHint ?? 'build.args — NAME=value, comma-separated'}>
        <Input
          value={form.args}
          onChange={(e) => onChange('args', e.target.value)}
          aria-label="Build args"
          placeholder={facts.args.filter((a) => a.default !== undefined).map((a) => `${a.name}=${a.default}`).join(', ') || 'NAME=value'}
          className={mono}
        />
      </Field>
      <Field label="Rebuild when" hint={`build.watch — a push touching these rebuilds; default ${path}`}>
        <Input value={form.watch} onChange={(e) => onChange('watch', e.target.value)}
          aria-label="Rebuild when" placeholder={`${path}, packages/shared`} className={mono} />
      </Field>
    </section>
  );
}
