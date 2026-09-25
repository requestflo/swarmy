import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { CodeView, Depth, useDepth } from '@/components/calm';
import { defaultAppName } from './template-words';

/**
 * Code depth for a template: the swarmy.yaml it deploys, rendered for this
 * app name (the same file the controller compiles; `@swarmy/templates` is
 * loaded only at Code depth). Built-in blueprints have no yaml, so they say so.
 */
export function TemplateCode({ meta }: { meta: BlueprintMetaView }): React.JSX.Element | null {
  const { atLeast } = useDepth();
  const [yaml, setYaml] = React.useState<string | null>(null);
  const show = atLeast('code');
  React.useEffect(() => {
    if (!show) return;
    let live = true;
    void import('@swarmy/templates').then((m) => {
      const t = m.findAppTemplate(meta.id);
      if (live) setYaml(t ? m.renderTemplateYaml(t, { stack: defaultAppName(meta) }) : '');
    });
    return () => {
      live = false;
    };
  }, [show, meta]);
  if (!show || yaml === null) return null;
  return (
    <Depth at="code">
      <CodeView
        title={`${meta.name} as code`}
        tabs={[
          {
            label: 'swarmy.yaml',
            code: yaml || `# ${meta.name} is a built-in blueprint: swarmy builds its plan in code, not from a swarmy.yaml.\n# Review it in the panel below before you deploy.`,
          },
        ]}
        source="readonly"
        note="What deploying this template runs. Commit it as swarmy.yaml in a connected repo and `swarmy deploy` ships the same app."
      />
    </Depth>
  );
}
