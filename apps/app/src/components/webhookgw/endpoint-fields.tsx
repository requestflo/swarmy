import * as React from 'react';
import { INBOUND_VERIFY_KINDS, type InboundVerifyKindView, type QueueConvention } from '@swarmy/core';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@swarmy/ui';
import { Field, kebab } from './form-bits';
import { TargetFields } from './target-fields';

export interface EndpointDraft {
  name: string;
  slug: string;
  slugTouched: boolean;
  domain: string;
  verifyKind: InboundVerifyKindView;
  secret: string;
  targetKind: 'forward' | 'queue';
  url: string;
  cacheCluster: string;
  queue: string;
  convention: QueueConvention;
  transformTemplate: string;
  responseTemplate: string;
  retentionDays: number;
}

export const EMPTY_ENDPOINT_DRAFT: EndpointDraft = {
  name: '',
  slug: '',
  slugTouched: false,
  domain: '',
  verifyKind: 'none',
  secret: '',
  targetKind: 'forward',
  url: '',
  cacheCluster: '',
  queue: '',
  convention: 'list',
  transformTemplate: '',
  responseTemplate: '',
  retentionDays: 30,
};

/** Vars available to both templates — shown as a hint row above the textareas. */
const TEMPLATE_VARS = ['{{body}}', '{{headers.<name>}}', '{{json.<path>}}', '{{slug}}', '{{deliveryId}}'];

const VERIFY_HINT: Record<InboundVerifyKindView, string> = {
  none: 'Anyone with the URL can post — fine for internal test hooks.',
  hmac: 'Sender signs the raw body: X-Signature: sha256=<hmac> with the shared secret.',
  github: 'Paste the same secret into the GitHub webhook form (X-Hub-Signature-256).',
  stripe: "Use the endpoint's signing secret from the Stripe dashboard (Stripe-Signature).",
};

/** Create/edit endpoint fields: identity, verification and where events go. */
export function EndpointFields({
  draft,
  onChange,
  editing = false,
}: {
  draft: EndpointDraft;
  onChange: (next: EndpointDraft) => void;
  /** Editing an existing endpoint: the slug is immutable, so it's read-only. */
  editing?: boolean;
}): React.JSX.Element {
  const set = (patch: Partial<EndpointDraft>): void => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={draft.name}
            placeholder="Stripe production"
            onChange={(e) =>
              set({ name: e.target.value, ...(draft.slugTouched ? {} : { slug: kebab(e.target.value) }) })
            }
          />
        </Field>
        <Field label="Slug (in the URL)">
          <Input
            value={draft.slug}
            placeholder="stripe-prod"
            disabled={editing}
            onChange={(e) => set({ slug: kebab(e.target.value), slugTouched: true })}
          />
        </Field>
      </div>

      <Field label="Custom domain (optional)">
        <Input
          value={draft.domain}
          placeholder="hooks.example.com"
          onChange={(e) => set({ domain: e.target.value })}
        />
      </Field>
      <p className="text-muted-foreground -mt-1 text-xs">
        Point a CNAME at the swarm and events verified here also answer at this domain.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Verify payloads">
          <Select value={draft.verifyKind} onValueChange={(v) => set({ verifyKind: v as InboundVerifyKindView })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {INBOUND_VERIFY_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k === 'none' ? 'No verification' : k === 'hmac' ? 'Generic HMAC' : k === 'github' ? 'GitHub' : 'Stripe'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {draft.verifyKind !== 'none' ? (
          <Field label="Shared secret">
            <Input
              type="password"
              value={draft.secret}
              placeholder="min 8 characters"
              onChange={(e) => set({ secret: e.target.value })}
            />
          </Field>
        ) : null}
      </div>
      <p className="text-muted-foreground -mt-1 text-xs">{VERIFY_HINT[draft.verifyKind]}</p>

      <TargetFields draft={draft} set={set} />

      <div className="grid gap-1.5">
        <p className="mono-label text-muted-foreground !mb-0">
          Vars: {TEMPLATE_VARS.map((v) => (
            <code key={v} className="mono-data bg-muted mr-1 rounded px-1 py-0.5">
              {v}
            </code>
          ))}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Transform body (optional)">
            <Textarea
              value={draft.transformTemplate}
              placeholder="{{json.data.object}}"
              className="mono-data min-h-20 text-xs"
              onChange={(e) => set({ transformTemplate: e.target.value })}
            />
          </Field>
          <Field label="Response body (optional)">
            <Textarea
              value={draft.responseTemplate}
              placeholder='{"received": "{{deliveryId}}"}'
              className="mono-data min-h-20 text-xs"
              onChange={(e) => set({ responseTemplate: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <Field label="Keep deliveries for (days)">
        <Input
          type="number"
          min={1}
          max={365}
          value={draft.retentionDays}
          onChange={(e) => set({ retentionDays: Math.max(1, Math.min(365, Number(e.target.value) || 30)) })}
        />
      </Field>
    </div>
  );
}
