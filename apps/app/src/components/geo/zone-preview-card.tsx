import * as React from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@swarmy/ui';
import { FileCodeIcon, PowerOffIcon } from 'lucide-react';

interface ZonePreview {
  summary: string;
  files: { path: string; contents: string }[];
}

interface ZonePreviewCardProps {
  enabled: boolean;
  preview: ZonePreview | undefined;
}

/** The Corefile + zonefile the agent would apply, health-filtered. */
export function ZonePreviewCard({ enabled, preview }: ZonePreviewCardProps): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Rendered zone preview</CardTitle>
        <CardDescription>The Corefile + zonefile the agent would apply.</CardDescription>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <EmptyState
            icon={<PowerOffIcon />}
            title="Geo-DNS is off"
            description="Enable Geo-DNS to render the live, health-filtered zone the agent would push."
            className="border-0 py-10"
          />
        ) : preview ? (
          <pre className="bg-muted mono-data max-h-64 overflow-auto rounded-xl p-4 text-xs">
            {preview.summary}
            {'\n\n'}
            {preview.files.map((f) => `# ${f.path}\n${f.contents}`).join('\n')}
          </pre>
        ) : (
          <EmptyState
            icon={<FileCodeIcon />}
            title="No preview yet"
            description="Add a record so there's a zone to render."
            className="border-0 py-10"
          />
        )}
      </CardContent>
    </Card>
  );
}
