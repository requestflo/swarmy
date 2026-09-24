import * as React from 'react';
import { PlusIcon, XIcon } from 'lucide-react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import type { EnvScope, ResourceScope, RuleDraft } from './policy-draft';

interface PolicyScopeFieldsProps {
  draft: RuleDraft;
  patch: (p: Partial<RuleDraft>) => void;
}

/** WHERE a rule applies: resource type, environment, and label matches. */
export function PolicyScopeFields({ draft, patch }: PolicyScopeFieldsProps): React.JSX.Element {
  const setLabel = (i: number, key: 'key' | 'value', v: string): void =>
    patch({ labels: draft.labels.map((l, j) => (j === i ? { ...l, [key]: v } : l)) });

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label className="mono-label">On</Label>
          <Select value={draft.resourceType} onValueChange={(v) => patch({ resourceType: v as ResourceScope })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Anything</SelectItem>
              <SelectItem value="service">Apps (services)</SelectItem>
              <SelectItem value="stack">Stacks</SelectItem>
              <SelectItem value="node">Nodes</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Environment</Label>
          <Select value={draft.env} onValueChange={(v) => patch({ env: v as EnvScope })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any environment</SelectItem>
              <SelectItem value="production">Production only</SelectItem>
              <SelectItem value="non-production">Everything but production</SelectItem>
              <SelectItem value="custom">A named environment…</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {draft.env === 'custom' && (
        <Input
          value={draft.customEnv}
          placeholder="staging"
          onChange={(e) => patch({ customEnv: e.target.value })}
        />
      )}
      <p className="text-muted-foreground text-xs">
        Environment is the <code className="mono-data">swarmy.env</code> label on the app or stack. Apps without it
        count as non-production.
      </p>

      <div className="grid gap-1.5">
        <Label className="mono-label">Only where labels match</Label>
        {draft.labels.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={l.key} placeholder="label (e.g. team)" onChange={(e) => setLabel(i, 'key', e.target.value)} />
            <span className="text-muted-foreground">=</span>
            <Input value={l.value} placeholder="value" onChange={(e) => setLabel(i, 'value', e.target.value)} />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Remove label match"
              onClick={() => patch({ labels: draft.labels.filter((_, j) => j !== i) })}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => patch({ labels: [...draft.labels, { key: '', value: '' }] })}
        >
          <PlusIcon className="size-4" /> Label match
        </Button>
      </div>
    </div>
  );
}
