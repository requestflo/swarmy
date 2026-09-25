import * as React from 'react';
import type { BucketDetailView } from '@swarmy/core';
import { CodeView, toYaml } from '@/components/calm';
import { fmtBytes, fmtCount } from './format';

/** What a bucket holds, how full it is, where its copies live and who uses it — in sentences. */
export function BucketSummary({ bucket: b, copies }: { bucket: BucketDetailView; copies: number }): React.JSX.Element {
  const max = b.quotas.maxSizeBytes;
  const pct = max ? Math.min(100, Math.round((b.usageBytes / max) * 100)) : null;
  const users = b.attachments.map((a) => `${a.stack} / ${a.service}`);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] leading-relaxed">
        {fmtBytes(b.usageBytes)} in {fmtCount(b.objects)} files{max ? `, of a ${fmtBytes(max)} limit` : ''}.{' '}
        <span className="text-muted-foreground">
          Each file is kept on {copies} server{copies === 1 ? '' : 's'}
          {copies > 1 ? ', so any one can be lost' : ''}.
        </span>
      </p>
      {pct !== null ? (
        <div
          role="meter"
          aria-label="Space used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="bg-muted h-1.5 overflow-hidden rounded-full"
        >
          <div className={pct >= 90 ? 'bg-status-warning h-full' : 'bg-primary h-full'} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="text-muted-foreground text-[13px]">
        {users.length ? `Used by ${users.join(', ')}.` : 'Not attached to an app yet.'}
      </p>
    </div>
  );
}

/** This bucket as swarmy.yaml (a `bucket` resource) and the env an attached app receives. */
export function BucketCode({ bucket: b, endpoint }: { bucket: BucketDetailView; endpoint: string | null }): React.JSX.Element {
  const yaml = toYaml({
    resources: {
      [b.name]: {
        type: 'bucket',
        ...(b.quotas.maxSizeBytes ? { quota: `${Math.round(b.quotas.maxSizeBytes / 1024 ** 3)}GB` } : {}),
      },
    },
  });
  const env = [
    `S3_ENDPOINT=${endpoint ?? 'http://swarmy-garage:3900'}`,
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
