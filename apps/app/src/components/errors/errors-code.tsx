import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';

/** Code depth of Errors: the injected SENTRY_* env, the real CLI, and the REST calls. */
export function ErrorsCode({ stack, enabled, dsn }: { stack: string; enabled: boolean; dsn: string | null }): React.JSX.Element {
  const shown = dsn ? dsn.replace(/\/\/([^@]+)@/, '//••••@') : '<turn error tracking on for a DSN>';
  const env = [
    `# injected into every ${stack} service on deploy (absent keys only; yours win)`,
    `SENTRY_DSN=${shown}`,
    'SENTRY_RELEASE=<git sha of the deploy>',
    'SENTRY_ENVIRONMENT=production',
    '',
    '# label',
    `swarmy.errors.enabled=${enabled}`,
  ].join('\n');
  const cli = [
    `# print this app's DSN`,
    `swarmy errors dsn --app ${stack}`,
    '',
    '# upload source maps from a build so stack traces show your code',
    `swarmy sourcemaps upload ./dist --app ${stack}`,
    '',
    '# the old key stops working at once',
    `swarmy errors rotate-key --app ${stack}`,
  ].join('\n');
  const rest = [restExchange('GET', `/stacks/${stack}/errors`, { stack, enabled, dsn: dsn ? shown : null }), '', curl('POST', `/stacks/${stack}/errors/rotate-key`)].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'env', code: env },
        { label: 'CLI', code: cli },
        { label: 'REST', code: rest },
      ]}
    />
  );
}
