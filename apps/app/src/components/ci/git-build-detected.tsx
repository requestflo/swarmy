import * as React from 'react';
import { BoxIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react';

/** Mirrors `BuildDetection` (packages/trpc/src/services/git-providers/detect-build.ts). */
export interface BuildDetected {
  builder: 'dockerfile' | 'railpack';
  framework?: string;
  language?: string;
  runtime?: string;
  start?: string;
  port?: number;
  healthPath?: string;
  summary: string;
  unknown?: boolean;
}

interface GitBuildDetectedProps {
  detected: BuildDetected;
  /** Show the swarmy.yaml starter (only when the repo has none yet). */
  showStarter: boolean;
}

/** The starter a zero-config repo needs: the port and health path Railpack's image will answer on. */
export function swarmyYamlStarter(d: BuildDetected, app: string): string {
  return [
    'version: 1',
    `app: ${app}`,
    'services:',
    '  web:',
    '    build: .',
    ...(d.port ? [`    port: ${d.port}`] : []),
    ...(d.healthPath && d.port ? ['    healthcheck:', `      path: ${d.healthPath}`] : []),
  ].join('\n');
}

/** "Detected: Next.js · Node 22 · start: npm start" — how swarmy will build this repo, before it builds. */
export function GitBuildDetected({ detected, showStarter }: GitBuildDetectedProps): React.JSX.Element {
  if (detected.unknown) {
    return (
      <p className="flex items-start gap-2 text-sm">
        <TriangleAlertIcon className="text-tone-warn mt-0.5 size-4 shrink-0" />
        <span>{detected.summary}</span>
      </p>
    );
  }
  const railpack = detected.builder === 'railpack';
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        {railpack ? (
          <SparklesIcon className="text-tone-ok size-4" />
        ) : (
          <BoxIcon className="text-tone-ok size-4" />
        )}
        <span>
          {railpack ? 'Detected: ' : ''}
          <span className="font-medium">{detected.summary}</span>
        </span>
      </p>
      {railpack ? (
        <p className="text-muted-foreground">
          No Dockerfile needed — swarmy builds it with Railpack
          {detected.port ? (
            <>
              {' '}
              and routes to port <span className="mono-data">{detected.port}</span>
              {detected.healthPath ? (
                <>
                  , health check <span className="mono-data">{detected.healthPath}</span>
                </>
              ) : null}
            </>
          ) : null}
          .
        </p>
      ) : null}
      {showStarter && detected.port ? (
        <pre className="bg-accent/40 mono-data overflow-x-auto rounded-xl px-4 py-3 text-xs">
          {swarmyYamlStarter(detected, 'my-app')}
        </pre>
      ) : null}
    </div>
  );
}
