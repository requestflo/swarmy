import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import { useStackServiceNames } from './use-stack-services';

/**
 * Code depth of Logs & traces: `swarmy logs <part> -f`, the REST log tail
 * (per service), the telemetry opt-in, the OTEL_* env swarmy injects
 * (absent keys only), and the dashboard query the stream itself reads.
 */
export function ObsCode({ stack, enabled, part, focus }: { stack: string; enabled: boolean; part?: string; focus?: string }): React.JSX.Element {
  const { names } = useStackServiceNames(stack);
  const svc = part || focus || names[0] || 'web';
  const cli = [
    `# follow one part's logs`,
    `swarmy logs ${svc} --app ${stack} -f`,
    '',
    '# the last 15 minutes, 500 lines',
    `swarmy logs ${svc} --app ${stack} --since 15m --tail 500`,
  ].join('\n');
  const rest = [
    '# the same tail over REST (the service id is on its Services page)',
    curl('GET', '/services/<service-id>/logs/stream?tail=100'),
    '',
    restExchange('GET', `/stacks/${stack}/telemetry`, { stack, enabled }),
  ].join('\n');
  const dashboard = [
    '# the stream on this page is a dashboard query (tRPC, not public REST)',
    'observability.logs',
    JSON.stringify({ from: '<now - 15m>', to: '<now>', stack, serviceName: part || undefined, limit: 500 }, null, 2),
    '',
    '# opening a line with a trace',
    'observability.traceDetail { "traceId": "<trace id>" }',
  ].join('\n');
  const env = [
    `# injected into ${stack}_${svc} on deploy (absent keys only; yours win)`,
    'OTEL_EXPORTER_OTLP_ENDPOINT=http://swarmy-otel-collector:4317',
    `OTEL_SERVICE_NAME=${svc}`,
    `OTEL_RESOURCE_ATTRIBUTES=swarmy.org_id=<org>,swarmy.stack=${stack},swarmy.service=${svc},deployment.environment=production`,
    'OTEL_TRACES_SAMPLER=parentbased_always_on',
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'CLI', code: cli },
        { label: 'REST', code: rest },
        { label: 'dashboard query', code: dashboard },
        { label: 'env', code: env },
      ]}
      source="readonly"
    />
  );
}
