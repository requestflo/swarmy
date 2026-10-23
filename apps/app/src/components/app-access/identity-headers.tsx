import * as React from 'react';
import { CopyButton } from '@swarmy/ui';
import { JWKS_PATH, type Simulation } from './simulate';
import type { AppAccessPerson, AppAccessRoute } from './types';

interface Props {
  stack: string;
  route: AppAccessRoute;
  person: AppAccessPerson | null;
  sim: Simulation;
}

/** In-swarm default `getSession` verifies against (`DEFAULT_SWARMY_JWKS_URL` in @swarmy/app-auth). */
const IN_SWARM_JWKS = `http://swarmy_controller:3021${JWKS_PATH}`;
/** base64url of `{"alg":"EdDSA",` — how every swarmy identity token begins. */
const JWT_PREFIX = 'eyJhbGciOiJFZERTQSIs';

/**
 * What the app receives for the simulated request: the identity headers the
 * edge copies from swarmy's 200 (`verifyAppRequest`), any client-sent copies
 * stripped first. The JWT is EdDSA-signed for five minutes, addressed to the
 * host; apps verify it against the controller's JWKS.
 */
export function IdentityHeaders({ stack, route, person, sim }: Props): React.JSX.Element {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const verify = [`# verify with JWKS: ${origin}${JWKS_PATH}`, `#   in the swarm: ${IN_SWARM_JWKS}`];
  const code =
    sim.outcome === 'passes' && person
      ? [
          'X-Swarmy-User:   <their swarmy user id>',
          `X-Swarmy-Email:  ${person.email ?? ''}`,
          `X-Swarmy-Groups: ${person.groups.join(',')}`,
          `X-Swarmy-Jwt:    ${JWT_PREFIX}…  # EdDSA · 5 min · aud ${route.host}`,
          ...verify,
        ].join('\n')
      : [
          `# nothing extra: ${sim.outcome === 'public' ? `${route.path} is public` : 'the request never arrives'}`,
          '# signed-in, allowed requests get X-Swarmy-User, X-Swarmy-Email,',
          '# X-Swarmy-Groups and a signed X-Swarmy-Jwt',
          ...verify,
        ].join('\n');
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="calm-eyebrow">What {stack} receives</span>
        <span className="text-muted-foreground rounded-full border px-2 py-0.5 font-mono text-[10.5px]">signed · verify with JWKS</span>
        <CopyButton value={`${origin}${JWKS_PATH}`} label="Copy JWKS URL" className="ml-auto" />
      </div>
      <pre className="calm-code overflow-x-auto px-3 py-2.5 text-[11.5px]">{code}</pre>
    </div>
  );
}
