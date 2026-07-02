import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { QueueConvention } from '@swarmy/core';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { EndpointDraft } from './endpoint-fields';
import { Field } from './form-bits';

/** Where verified events go: forward URL, or a queue on a managed cache. */
export function TargetFields({
  draft,
  set,
}: {
  draft: EndpointDraft;
  set: (patch: Partial<EndpointDraft>) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const caches = useQuery(trpc.cache.list.queryOptions());

  return (
    <>
      <Field label="Send events to">
        <Select value={draft.targetKind} onValueChange={(v) => set({ targetKind: v as 'forward' | 'queue' })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="forward">Forward — POST to a URL the controller can reach</SelectItem>
            <SelectItem value="queue">Queue — push onto a managed cache queue</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {draft.targetKind === 'forward' ? (
        <Field label="Forward URL">
          <Input
            value={draft.url}
            placeholder="https://api.example.com/hooks/stripe"
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Cache cluster">
            <Select value={draft.cacheCluster || undefined} onValueChange={(v) => set({ cacheCluster: v })}>
              <SelectTrigger><SelectValue placeholder="Pick a cache" /></SelectTrigger>
              <SelectContent>
                {(caches.data ?? []).map((c) => (
                  <SelectItem key={`${c.stack}/${c.name}`} value={`${c.stack}/${c.name}`}>
                    {c.stack}/{c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Queue">
            <Input value={draft.queue} placeholder="webhooks" onChange={(e) => set({ queue: e.target.value })} />
          </Field>
          <Field label="Convention">
            <Select value={draft.convention} onValueChange={(v) => set({ convention: v as QueueConvention })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="list">Raw list</SelectItem>
                <SelectItem value="bullmq">BullMQ</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </>
  );
}
