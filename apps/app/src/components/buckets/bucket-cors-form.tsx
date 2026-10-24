import * as React from 'react';
import { CORS_METHODS } from '@swarmy/core';
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@swarmy/ui';
import { MAX_AGE_OPTIONS, methodLabel } from './cors-model';
import type { CorsDraft } from './use-cors-draft';

/** Controls: add an origin, pick the methods and the preflight cache, save to the bucket. */
export function BucketCorsForm({ draft: d, wildcards }: { draft: CorsDraft; wildcards: boolean }): React.JSX.Element {
  const [text, setText] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const add = () => {
    const why = d.add(text);
    setProblem(why);
    if (!why) setText('');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="grid min-w-0 flex-1 basis-56 gap-1">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={wildcards ? 'https://shop.example.com or https://*.example.com' : 'https://shop.example.com'}
            aria-label="Website origin"
            aria-invalid={problem ? true : undefined}
            className="mono-data"
            autoComplete="off"
            spellCheck={false}
          />
          {problem ? <p className="text-tone-bad text-xs">{problem}</p> : null}
        </div>
        <Button variant="outline" disabled={!text.trim()} onClick={add}>
          Add origin
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Methods" className="flex flex-wrap gap-1">
          {CORS_METHODS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={d.methods.includes(m)}
              onClick={() => d.toggle(m)}
              className={cn(
                'h-8 rounded-full border px-2.5 font-mono text-[11.5px] font-semibold pointer-coarse:min-h-11',
                d.methods.includes(m) ? 'bg-surface-2 border-foreground/30 text-foreground dark:bg-accent' : 'text-muted-foreground',
              )}
            >
              {methodLabel(m)}
            </button>
          ))}
        </div>
        <Select value={d.age} onValueChange={d.setAge}>
          <SelectTrigger className="h-9 w-auto min-w-36 pointer-coarse:min-h-11" aria-label="Cache preflight">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAX_AGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                Cache preflight · {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" className="ml-auto" disabled={d.saving || !d.dirty} onClick={d.save}>
          {d.saving ? 'Saving…' : d.origins.length ? 'Save browser rules' : 'Remove browser rules'}
        </Button>
      </div>
    </div>
  );
}
