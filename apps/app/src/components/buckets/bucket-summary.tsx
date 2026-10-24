import * as React from 'react';
import type { BucketDetailView } from '@swarmy/core';
import { CodeView, toYaml } from '@/components/calm';
import { REACH_YAML, type ReachMode } from './reach-model';

/** This bucket as swarmy.yaml (a `bucket` resource) and the env an attached app receives. */
export function BucketCode({
  bucket: b,
  endpoint,
  publicEndpoint,
  mode,
}: {
  bucket: BucketDetailView;
  endpoint: string | null;
  /** The org's public S3 endpoint (S3_PUBLIC_ENDPOINT), when there is one. */
  publicEndpoint: string | null;
  mode?: ReachMode;
}): React.JSX.Element {
  const yaml = toYaml({
    resources: {
      [b.name]: {
        type: 'bucket',
        ...(mode && mode !== 'INTERNAL' ? { access: REACH_YAML[mode] } : {}),
        ...(b.quotas.maxSizeBytes ? { quota: `${Math.round(b.quotas.maxSizeBytes / 1024 ** 3)}GB` } : {}),
      },
    },
  });
  const env = [
    `S3_ENDPOINT=${endpoint ?? 'http://swarmy-garage:3900'}`,
    ...(publicEndpoint ? [`S3_PUBLIC_ENDPOINT=${publicEndpoint}  # sign browser links with it${mode === 'PUBLIC' ? '' : '; answers once access is public'}`] : []),
    `S3_BUCKET=${b.name}`,
    'S3_REGION=swarmy',
    `S3_ACCESS_KEY_ID=${b.attachments[0]?.accessKeyId ?? '<key id>'}`,
    `S3_SECRET_ACCESS_KEY_FILE=/run/secrets/${b.attachments[0]?.secretName ?? '<secret>'}`,
  ].join('\n');
  return (
    <CodeView
      title="This bucket as code"
      tabs={[
        { label: 'swarmy.yaml', code: `# in the app's swarmy.yaml\n${yaml}` },
        { label: 'App env', code: `# what an attached service receives\n${env}` },
      ]}
      source="yaml"
    />
  );
}
