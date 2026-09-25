import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import { useStackServiceNames } from './use-stack-services';

/**
 * Code depth of Logs & traces: the exact OTEL_* env swarmy injects (per
 * `otel-injection.ts`, never overwriting a value you set), `swarmy logs`,
 * and the telemetry opt-in over REST.
 */
export function ObsCode({ stack, enabled }: { stack: string; enabled: boolean }): React.JSX.Element {
  const { names } = useStackServiceNames(stack);
  const svc = names[0] ?? 'web';
  const env = [
    `# injected into ${stack}_${svc} on deploy (absent keys only; yours win)`,
    'OTEL_EXPORTER_OTLP_ENDPOINT=http://swarmy-otel-collector:4317',
    `OTEL_SERVICE_NAME=${svc}`,
    `OTEL_RESOURCE_ATTRIBUTES=swarmy.org_id=<org>,swarmy.stack=${stack},swarmy.service=${svc},deployment.environment=production`,
    'OTEL_TRACES_SAMPLER=parentbased_always_on',
    '',
    '# labels on every service',
    `swarmy.otel.enabled=${enabled}`,
    `swarmy.telemetry=${enabled ? 'on' : 'off'}`,
    `swarmy.stack=${stack}`,
  ].join('\n');
  const cli = [
    `# follow one service's logs`,
    `swarmy logs ${svc} --app ${stack} -f`,
    '',
    '# the last hour, 500 lines',
    `swarmy logs ${svc} --app ${stack} --since 1h --tail 500`,
  ].join('\n');
  const rest = [
    restExchange('GET', `/stacks/${stack}/telemetry`, { stack, enabled }),
    '',
    curl('PUT', `/stacks/${stack}/telemetry`, { enabled: !enabled }),
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'env', code: env },
        { label: 'CLI', code: cli },
        { label: 'REST', code: rest },
      ]}
      source="dashboard"
    />
  );
}
