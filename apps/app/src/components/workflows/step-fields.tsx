import * as React from 'react';
import { Input, Label, Textarea } from '@swarmy/ui';
import type { StepDraft } from './step-draft';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/** Per-kind config fields for one step of the builder. */
export function StepFields({
  draft,
  onChange,
}: {
  draft: StepDraft;
  onChange: (next: StepDraft) => void;
}): React.JSX.Element {
  const set = (patch: Partial<StepDraft>): void => onChange({ ...draft, ...patch });
  const num = (v: string, min: number): number => Math.max(min, Number(v) || 0);

  return (
    <div className="grid gap-3">
      <Field label="Step name">
        <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="extract-text" />
      </Field>

      {draft.kind === 'container' ? (
        <>
          <Field label="Image">
            <Input value={draft.image} onChange={(e) => set({ image: e.target.value })} placeholder="alpine:3.20" />
          </Field>
          <Field label="Command" hint='Quoted args ok — e.g. sh -c "echo hi"'>
            <Input value={draft.command} onChange={(e) => set({ command: e.target.value })} placeholder="sh -c 'node run.js'" />
          </Field>
          <Field label="Environment" hint="KEY=VALUE, one per line.">
            <Textarea rows={2} value={draft.env} onChange={(e) => set({ env: e.target.value })} placeholder={'MODE=batch'} />
          </Field>
        </>
      ) : null}

      {draft.kind === 'service-exec' ? (
        <>
          <Field label="Service" hint="Docker service name (or id) to exec into.">
            <Input value={draft.serviceRef} onChange={(e) => set({ serviceRef: e.target.value })} placeholder="api" />
          </Field>
          <Field label="Command">
            <Input value={draft.command} onChange={(e) => set({ command: e.target.value })} placeholder="./bin/migrate" />
          </Field>
        </>
      ) : null}

      {draft.kind === 'webhook' ? (
        <>
          <Field label="URL" hint="Receives POST {runId, input, prevOutput}.">
            <Input value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/hook" />
          </Field>
          <Field
            label="HMAC secret"
            hint={
              draft.hasStoredSecret
                ? 'A secret is stored — leave blank to keep it. Sent as X-Swarmy-Signature.'
                : 'Optional. Signs the body as X-Swarmy-Signature: sha256=…'
            }
          >
            <Input
              type="password"
              value={draft.secret}
              onChange={(e) => set({ secret: e.target.value })}
              placeholder={draft.hasStoredSecret ? '••••••••  (unchanged)' : 'whsec_…'}
            />
          </Field>
        </>
      ) : null}

      {draft.kind === 'approval' ? (
        <Field label="Prompt" hint="Shown to the approver on the run page.">
          <Textarea rows={2} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Ship this to production?" />
        </Field>
      ) : null}

      {draft.kind === 'delay' ? (
        <Field label="Delay (seconds)">
          <Input type="number" min={1} value={draft.seconds} onChange={(e) => set({ seconds: num(e.target.value, 1) })} />
        </Field>
      ) : null}

      {draft.kind === 'container' || draft.kind === 'service-exec' || draft.kind === 'webhook' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Timeout (seconds)">
            <Input type="number" min={1} value={draft.timeoutSec} onChange={(e) => set({ timeoutSec: num(e.target.value, 1) })} />
          </Field>
          <Field label="Retries">
            <Input type="number" min={0} max={5} value={draft.retries} onChange={(e) => set({ retries: Math.min(5, num(e.target.value, 0)) })} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
