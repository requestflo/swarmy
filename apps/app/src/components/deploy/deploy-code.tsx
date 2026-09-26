import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { CodeView, toYaml } from '@/components/calm';
import { TemplateCode } from '@/components/blueprints/template-code';
import type { DeploySource } from './deploy-choice';

/**
 * Code depth for the Deploy hub: a template's real swarmy.yaml, or for git a
 * starter swarmy.yaml (packages/app-config keys) and the real CLI. Compose
 * and image have their own pages, each with its own Code view.
 */
export function DeployCode({ source, template }: { source: DeploySource; template: BlueprintMetaView | null }): React.JSX.Element | null {
  if (source === 'template') return template ? <TemplateCode meta={template} /> : null;
  const yaml = toYaml({ version: 1, app: 'my-app', services: { web: { build: '.', port: 3000 } } });
  const cli = [
    '# after connecting the repo in the dashboard',
    'swarmy login',
    'swarmy link my-app',
    'swarmy check      # validate swarmy.yaml',
    'swarmy deploy     # build on your servers and ship',
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: `# swarmy.yaml at the root of the repo\n${yaml}` },
        { label: 'CLI', code: cli },
      ]}
      source="yaml"
      note="No swarmy.yaml yet? swarmy converts a compose file in the repo into one for you to commit, or builds a Dockerfile."
    />
  );
}
