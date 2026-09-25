import * as React from 'react';
import { CodeView, toYaml, withHeader } from '@/components/calm';
import { IDENTITY_HEADERS, type AppAccessViewData } from './types';

/**
 * Code depth of Access: the route entries swarmy writes (`access.login` in the
 * `swarmy.ingress.routes` label), who may enter, the headers the app gets,
 * and — when the app has its own sign-in — the swarmy.yaml `auth:` block.
 */
export function AccessCode({ view }: { view: AppAccessViewData }): React.JSX.Element {
  const routes = view.routes
    .filter((r) => !r.endUserAuth)
    .map((r) => JSON.stringify({ host: r.host, path: r.path, ...(r.requireLogin ? { access: { login: true } } : {}) }))
    .join('\n');
  const who = view.rules.everyone ? 'everyone in the organisation' : [...view.rules.groups.map((g) => `group ${g}`), ...view.rules.people.map((p) => `person ${p}`)].join(', ') || 'nobody yet';
  const edge = [
    '# swarmy.ingress.routes entries (on each service)',
    routes || '# no routes yet',
    '',
    `# who can enter: ${who}`,
    `# the app receives: ${IDENTITY_HEADERS.join(', ')}`,
  ].join('\n');
  const tabs = [{ label: 'routes', code: edge }];
  const a = view.endUserAuth;
  if (a) {
    tabs.push({
      label: 'swarmy.yaml',
      code: withHeader(
        'swarmy.yaml · the app’s own sign-in (a swarmy-auth service)',
        toYaml({ auth: { providers: a.providers, email: a.email, allowed_domains: a.allowedDomains.length ? a.allowedDomains : undefined } }),
      ),
    });
  }
  return <CodeView tabs={tabs} source="readonly" note="Require login and who can enter are dashboard settings stored on the app’s routes and in policy. The app’s own sign-in lives in swarmy.yaml." />;
}
