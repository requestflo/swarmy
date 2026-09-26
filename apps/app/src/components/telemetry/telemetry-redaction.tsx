import * as React from 'react';
import { Button } from '@swarmy/ui';
import { defaultRedactionRules, type TelemetryRedactionRule } from '@swarmy/core';
import { Depth, Section } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { RedactionRuleForm } from './redaction-rule-form';

/** Built-in rules can be switched off, not removed. */
const BUILT_IN = new Set(defaultRedactionRules().map((r) => r.id));

const TARGET: Record<TelemetryRedactionRule['target'], string> = { span: 'span', log: 'log', both: 'span + log' };

function ruleTech(r: TelemetryRedactionRule): string {
  return r.kind === 'drop-attr' ? `${TARGET[r.target]} attrs · drop ${r.match}` : `${r.match} → ${r.replace ?? ''}`;
}

/** Redaction: what is scrubbed before anything is stored. */
export function TelemetryRedaction({
  rules,
  onChange,
}: {
  rules: TelemetryRedactionRule[];
  onChange: (rules: TelemetryRedactionRule[]) => void;
}): React.JSX.Element {
  const [adding, setAdding] = React.useState(false);
  const set = (id: string, enabled: boolean) => onChange(rules.map((r) => (r.id === id ? { ...r, enabled } : r)));
  return (
    <Section
      title="Redaction"
      hint="scrubbed before anything is stored"
      action={
        adding ? null : (
          <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setAdding(true)}>
            Add rule
          </Button>
        )
      }
      flush
    >
      <ul className="flex flex-col">
        {rules.map((r) => (
          <li key={r.id} className="border-border flex min-h-12 items-center gap-3 border-b py-2 last:border-b-0">
            <QuietSwitch checked={r.enabled} onCheckedChange={(on) => set(r.id, on)} aria-label={r.name} />
            <span className="min-w-0 flex-1 text-[14px]">{r.name}</span>
            <Depth at="controls">
              <span className="text-muted-foreground hidden max-w-[45%] truncate text-right font-mono text-[11px] sm:block" title={ruleTech(r)}>
                {ruleTech(r)}
              </span>
            </Depth>
            {!BUILT_IN.has(r.id) ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground pointer-coarse:min-h-11"
                onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
                aria-label={`Remove ${r.name}`}
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {adding ? (
        <RedactionRuleForm
          taken={rules.map((r) => r.id)}
          onCancel={() => setAdding(false)}
          onAdd={(rule) => {
            onChange([...rules, rule]);
            setAdding(false);
          }}
        />
      ) : null}
    </Section>
  );
}
