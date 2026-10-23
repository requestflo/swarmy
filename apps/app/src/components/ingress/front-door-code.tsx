import * as React from 'react';
import { CodeView } from '@/components/calm';
import { previewFiles, type PreviewData } from './driver-panel';

/**
 * The Front door at Code: the raw config swarmy renders (read only) and the
 * dashboard calls behind this page's switches — tRPC, as there is no public
 * REST route for the edge settings yet.
 */
export function FrontDoorCode({
  driver,
  preview,
  topology,
  edgeId,
  ask,
}: {
  driver: string;
  preview: PreviewData | undefined;
  topology: string;
  edgeId: string | null;
  ask: string | null;
}): React.JSX.Element {
  const j = (v: unknown): string => JSON.stringify(v);
  const calls = [
    '# what this page reads',
    'ingress.getConfig',
    'ingress.previewConfig {}',
    'nodes.list',
    '',
    '# the switches (admins)',
    `ingress.setTopology ${j({ topology })}`,
    `nodes.setRole ${j({ id: edgeId ?? '<server id>', ingress: true, outlet: true })}`,
    `nodes.setRole ${j({ id: edgeId ?? '<server id>', ingress: false })}`,
    `ingress.setOnDemandTls ${j({ enabled: true, askUrl: ask ?? '<https://your-controller/ingress/ask>' })}`,
    `ingress.setDriver ${j({ driver })}`,
  ].join('\n');
  return (
    <CodeView
      tabs={[
        {
          label: driver === 'cloudflared' ? 'config.yml' : 'Caddyfile',
          code: preview ? `# ${preview.summary}\n${previewFiles(preview)}` : '# swarmy writes no routing config (None)',
        },
        { label: 'Dashboard calls', code: calls },
      ]}
      source="readonly"
      note="The config is read only: swarmy renders it from your domains and these settings. Change it with the switches on this page, not by hand."
    />
  );
}
