import * as React from 'react';
import type { BlueprintMetaView, BlueprintPlanView } from '@swarmy/core';
import { Input } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { ConfigureField } from './configure-field';
import type { ConfigureFormState } from './use-configure-form';

function Tag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10.5px]">{children}</span>;
}

/** The secrets the plan generates (names only, never values), from the dry-run. */
export function generatedSecrets(plan: BlueprintPlanView | undefined, stack: string): string[] {
  if (!plan) return [];
  const out: string[] = [];
  if (plan.steps.some((s) => s.kind === 'db.provision')) out.push('database password');
  for (const s of plan.steps) {
    if (s.kind !== 'secret') continue;
    const family = s.detail.family ?? '';
    out.push(family.startsWith(`${stack}-`) ? family.slice(stack.length + 1) : family);
  }
  return out;
}

/**
 * Secrets: every one the template generates, masked and tagged "generated",
 * then its text settings, editable and tagged "optional". Switches (on/off
 * settings) and the size are at Controls.
 */
export function ConfigureSecrets({
  meta,
  form,
  plan,
}: {
  meta: BlueprintMetaView;
  form: ConfigureFormState;
  plan: BlueprintPlanView | undefined;
}): React.JSX.Element | null {
  const secrets = generatedSecrets(plan, form.name);
  const settings = meta.options.filter((o) => o.kind === 'string');
  if (!plan && !settings.length) return <div className="shimmer-line h-24 rounded-xl" />;
  if (!secrets.length && !settings.length) return null;
  return (
    <ConfigureField label={settings.length ? 'Secrets and settings' : 'Secrets'} help={secrets.length ? 'Made for you when you deploy. You never paste one, and swarmy never shows them again.' : undefined}>
      <ul className="border-border divide-border divide-y rounded-xl border">
        {secrets.map((s) => (
          <li key={s} className="flex min-h-11 items-center gap-3 px-3.5 py-2">
            <span className="w-40 min-w-0 shrink-0 truncate font-mono text-[12.5px]">{s}</span>
            <span aria-label="hidden value" className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[12.5px] tracking-[0.2em]">••••••••••••••••</span>
            <Tag>generated</Tag>
          </li>
        ))}
        {settings.map((o) => (
          <li key={o.key} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2">
            <label htmlFor={`opt-${o.key}`} className="w-40 min-w-0 shrink-0 truncate font-mono text-[12.5px]" title={o.help}>
              {o.label}
            </label>
            <Input
              id={`opt-${o.key}`}
              value={String(form.options[o.key] ?? '')}
              placeholder={o.placeholder}
              onChange={(e) => form.setOption(o.key, e.target.value)}
              className="h-9 min-w-0 flex-1 basis-40 font-mono text-[12.5px]"
            />
            <Tag>optional</Tag>
          </li>
        ))}
      </ul>
      <Tech>secrets: generated at deploy · Docker secrets or service env · write-only, never stored by the controller</Tech>
    </ConfigureField>
  );
}
