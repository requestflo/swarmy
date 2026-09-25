import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { CodeView, curl, toYaml } from '@/components/calm';
import { TemplateCode } from '@/components/blueprints/template-code';
import type { DeployChoice } from './deploy-choice';

/**
 * Code depth for the Deploy hub: the file each choice produces and how it
 * ships. Templates render their real swarmy.yaml; git shows a starter
 * swarmy.yaml (packages/app-config keys) and the real CLI; compose and image
 * show the REST calls (POST /stacks, POST /services).
 */
export function DeployCode({
  choice,
  template,
}: {
  choice: DeployChoice;
  template: BlueprintMetaView | null;
}): React.JSX.Element | null {
  if (choice.kind === 'template') return template ? <TemplateCode meta={template} /> : null;
  if (choice.kind === 'git') {
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
  if (choice.kind === 'compose') {
    const compose = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n';
    return (
      <CodeView
        tabs={[
          { label: 'compose', code: compose },
          { label: 'REST', code: curl('POST', '/stacks', { name: 'my-app', compose_source: compose }) },
        ]}
        note="The same deploy over REST: POST /stacks with the compose text. It runs as one app."
      />
    );
  }
  return (
    <CodeView
      tabs={[{ label: 'REST', code: curl('POST', '/services', { name: 'web', image: 'nginx:1.27', replicas: 1 }) }]}
      note="The same deploy over REST: POST /services with the image. It starts one copy unless you ask for more."
    />
  );
}
