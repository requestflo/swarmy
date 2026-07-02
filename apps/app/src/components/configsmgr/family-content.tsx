import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { relTime } from '@/lib/format';

/** Read-only preview of one version's content (configs are readable). */
export function FamilyContent({
  family,
  version,
}: {
  family: string;
  /** Omit for the current version. */
  version?: number;
}): React.JSX.Element {
  const trpc = useTRPC();
  const content = useQuery(
    trpc.configs.content.queryOptions({
      family,
      ...(version !== undefined ? { version } : {}),
    }),
  );

  return (
    <section className="space-y-2">
      <p className="mono-label text-muted-foreground !mb-0">
        Content{content.data ? ` · v${content.data.version}` : ''}
      </p>
      {content.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer-line h-6 rounded-lg" />
          ))}
        </div>
      ) : content.isError ? (
        <p className="text-status-offline text-xs">{content.error.message}</p>
      ) : !content.data ? null : (
        <>
          <pre className="border-border bg-accent/40 mono-data max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-xl border p-3 text-xs leading-5">
            {content.data.content}
          </pre>
          <p className="text-muted-foreground text-xs">
            Mounted at <span className="mono-data">{content.data.mountPath}</span> · saved{' '}
            {relTime(content.data.createdAt)}
          </p>
        </>
      )}
    </section>
  );
}
