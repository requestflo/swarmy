import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2Icon } from 'lucide-react';
import { BlueprintParamsInput, type BlueprintMetaView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useApps } from '@/components/apps/use-apps';
import { defaultSizeForNodes } from '@/components/blueprints/blueprint-option-fields';
import { memoryLabel } from '@/components/blueprints/template-words';
import { useTemplatePlan } from '@/components/blueprints/use-template-plan';
import { useTemplateDeploy } from '@/components/deploy/use-template-deploy';
import { fitsIn, useServerRoom } from '@/components/deploy/use-server-room';
import { bytes } from '@/lib/format';
import type { IntentAction } from '@/lib/intents';
import { useOnlineNodeCount } from '@/lib/use-online-node-count';
import { Pane, type PaneProps } from './intent-pane';

type DeployAction = Extract<IntentAction, { kind: 'deploy' }>;

function useFit(meta: BlueprintMetaView): string {
  const room = useServerRoom();
  const top = room.roomiest;
  const need = memoryLabel(meta);
  if (room.pending) return need ? `${need} · checking room…` : 'checking room…';
  if (!top) return need ?? 'no server online';
  if (!meta.minMemoryMb) return `${bytes(top.freeBytes)} free on ${top.name}`;
  return fitsIn(meta.minMemoryMb, top.freeBytes) ? `${need} · fits on ${top.name}` : `${need} · ${top.name} has ${bytes(top.freeBytes)} free`;
}

/** "deploy ghost as blog": the template, its name and address, whether it fits, and the one coral Deploy. */
function Ready({ meta, action, intent, ctaRef, onGo }: PaneProps & { meta: BlueprintMetaView; action: DeployAction }): React.JSX.Element {
  const online = useOnlineNodeCount();
  const apps = useApps();
  const options = React.useMemo(() => Object.fromEntries(meta.options.map((o) => [o.key, o.defaultValue])), [meta]);
  const parsed = BlueprintParamsInput.safeParse({ name: action.name, size: defaultSizeForNodes(online), options });
  const plan = useTemplatePlan(meta, { name: action.name, options });
  const deploy = useTemplateDeploy(meta);
  const fit = useFit(meta);
  const taken = [...apps.apps, ...apps.platform].some((a) => a.name === action.name);
  const address = plan.data?.autoHost ?? (plan.isPending ? 'working it out…' : plan.isError ? 'made when it deploys' : 'none: it stays private');
  const where = action.to ? `swarmy picks the server for now (you said “${action.to}”)` : 'swarmy picks the server with room';
  const failed = deploy.result?.steps.find((s) => s.status === 'failed');

  return (
    <Pane
      eyebrow="Action · preview"
      title={failed ? `${action.name} didn’t go out.` : `Deploy ${meta.name} as ${action.name}`}
      body={
        failed
          ? `${failed.label} failed${failed.error ? `: ${failed.error}` : ''}. Nothing else changed. Edit the details and try again.`
          : taken
            ? `There’s already an app called ${action.name}. Pick another name: “deploy ${meta.id} as another-name”.`
            : `${meta.tagline.replace(/\.?$/, '.')} It goes out with the template’s defaults and gets a working HTTPS address straight away — no DNS needed yet.`
      }
      rows={[
        ['Template', meta.version ? `${meta.name} ${meta.version}` : meta.name],
        ['Name', action.name],
        ['Address', address],
        ['Memory', fit],
        ['Server', where],
      ]}
      cta={
        <div className="flex flex-wrap gap-2">
          <Button ref={ctaRef} disabled={!parsed.success || taken || deploy.pending || !!failed} onClick={() => parsed.success && deploy.run(parsed.data)}>
            {deploy.pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {deploy.pending ? `Deploying ${action.name}…` : `Deploy ${action.name}`}
          </Button>
          {intent.edit ? (
            <Button variant="outline" onClick={() => onGo({ ...intent, action: intent.edit! })}>
              Edit details
              <kbd className="border-border rounded border px-1 font-mono text-[10.5px]">⇥</kbd>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

/** Loads the template, then the preview. No CLI or REST route deploys a template yet, so there's no code line. */
export function DeployPane(props: PaneProps & { action: DeployAction }): React.JSX.Element {
  const trpc = useTRPC();
  const list = useQuery(trpc.blueprints.list.queryOptions());
  const meta = list.data?.find((m) => m.id === props.action.template && !m.docOnly);
  if (meta) return <Ready {...props} meta={meta} />;
  return <Pane eyebrow="Action · preview" title={props.intent.title} body={list.isPending ? 'Looking up the template…' : 'That template isn’t available.'} rows={[]} cta={null} />;
}
