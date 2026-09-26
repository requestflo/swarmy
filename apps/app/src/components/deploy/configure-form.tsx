import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Loader2Icon } from 'lucide-react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { CalmPage, SayHeader } from '@/components/calm';
import { BlueprintDeployResult } from '@/components/blueprints/blueprint-deploy-result';
import { TemplateCode } from '@/components/blueprints/template-code';
import { useTemplatePlan } from '@/components/blueprints/use-template-plan';
import { ConfigureAside } from './configure-aside';
import { ConfigureControls } from './configure-controls';
import { ConfigureIdentity } from './configure-identity';
import { ConfigureSecrets } from './configure-secrets';
import { ConfigureWhere } from './configure-where';
import { useConfigureForm } from './use-configure-form';
import { useTemplateDeploy } from './use-template-deploy';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Configure (board 3): the page IS the review. Name, address, where it runs
 * and secrets at Summary; size and switches at Controls; the swarmy.yaml at
 * Code. One coral Deploy (⌘/Ctrl+Enter) runs the same `blueprints.deploy`.
 */
export function ConfigureForm({ meta, name }: { meta: BlueprintMetaView; name?: string }): React.JSX.Element {
  const form = useConfigureForm(meta, name);
  const plan = useTemplatePlan(meta, form.params ?? undefined);
  const deploy = useTemplateDeploy(meta);
  const label = form.params?.name ?? meta.name;
  const go = React.useCallback(() => {
    if (form.params) deploy.run(form.params);
  }, [form.params, deploy]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        go();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const host = form.ownDomain ? form.domain.trim() || null : (plan.data?.autoHost ?? null);
  return (
    <CalmPage
      wide
      crumbs={[{ label: 'Deploy', to: '/deploy' }, { label: meta.id }]}
      className="xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]"
      actions={
        <>
          <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
            <Link to="/deploy">Back</Link>
          </Button>
          <Button size="sm" onClick={go} disabled={!form.params || deploy.pending || !!deploy.result} className="pointer-coarse:min-h-11">
            {deploy.pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Deploy {label}
            <kbd className="bg-primary-foreground/15 hidden rounded px-1 font-mono text-[10.5px] sm:inline">{IS_MAC ? '⌘↵' : 'Ctrl ↵'}</kbd>
          </Button>
        </>
      }
      aside={
        <>
          <TemplateCode meta={meta} name={form.params?.name} options={form.options} />
          <ConfigureAside meta={meta} plan={plan.data} host={host} ownDomain={form.ownDomain} />
        </>
      }
    >
      <SayHeader
        size="md"
        eyebrow="Nothing runs until you press Deploy"
        title={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            Configure {label}
            <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 font-sans text-[13px] font-semibold tracking-normal">
              {[meta.name, meta.version].filter(Boolean).join(' ')}
            </span>
          </span>
        }
      />
      {deploy.result ? (
        <BlueprintDeployResult result={deploy.result} onClose={deploy.clear} />
      ) : (
        <div className="flex flex-col gap-5">
          <ConfigureIdentity meta={meta} form={form} autoHost={plan.data?.autoHost} planPending={plan.isPending} />
          <ConfigureWhere />
          <ConfigureSecrets meta={meta} form={form} plan={plan.data} />
          <ConfigureControls meta={meta} form={form} />
          {plan.isError ? <p className="text-tone-bad text-[13px]">{plan.error.message}</p> : null}
        </div>
      )}
    </CalmPage>
  );
}
