import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { CodeView, Depth, useDepth } from '@/components/calm';
import { defaultAppName } from './template-words';

/**
 * Code depth for a template: the swarmy.yaml it deploys, rendered for this
 * app name and options (the same file the controller compiles;
 * `@swarmy/templates` is loaded only at Code depth), and the real CLI that
 * ships the same file from a repo. Templates have no REST endpoint, so there's
 * no REST tab. Built-in blueprints have no yaml, so they say so.
 */
export function TemplateCode({
  meta,
  name,
  options,
}: {
  meta: BlueprintMetaView;
  /** The app name typed on Configure (defaults to the template's own). */
  name?: string;
  options?: Record<string, string | boolean>;
}): React.JSX.Element | null {
  const { atLeast } = useDepth();
  const [yaml, setYaml] = React.useState<string | null>(null);
  const show = atLeast('code');
  const stack = name || defaultAppName(meta);
  const optKey = JSON.stringify(options ?? {});
  React.useEffect(() => {
    if (!show) return;
    let live = true;
    void import('@swarmy/templates').then((m) => {
      const t = m.findAppTemplate(meta.id);
      const opts = JSON.parse(optKey) as Record<string, string | boolean>;
      if (live) setYaml(t ? m.renderTemplateYaml(t, { stack, options: opts }) : '');
    });
    return () => {
      live = false;
    };
  }, [show, meta, stack, optKey]);
  if (!show || yaml === null) return null;
  const cli = ['# commit the file above as swarmy.yaml in a connected repo, then', 'swarmy login', `swarmy link ${stack}`, 'swarmy check      # validate swarmy.yaml', 'swarmy deploy     # ship it'].join('\n');
  return (
    <Depth at="code">
      <CodeView
        title={`${meta.name} as code`}
        tabs={[
          {
            label: 'swarmy.yaml',
            code: yaml || `# ${meta.name} is a built-in blueprint: swarmy builds its plan in code, not from a swarmy.yaml.`,
          },
          ...(yaml ? [{ label: 'CLI', code: cli }] : []),
        ]}
        source="readonly"
        note="What deploying this template runs. Templates have no REST endpoint yet; the dashboard's Deploy calls the controller directly."
      />
    </Depth>
  );
}
