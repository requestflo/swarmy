import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CodeView, Depth, Section } from '@/components/calm';
import { THREE_WAYS, THREE_WAYS_ROUTE } from './api-three-ways';

/** The spec the controller serves, unauthenticated (packages/api-rest app.ts). */
const OPENAPI_SPEC = '/api/v1/openapi.json';

/**
 * Settings → API: everything on screen is also code. One real action shown
 * three ways — curl, the swarmy CLI, Terraform — all on the same route, so the
 * same key scopes, policy check and audit row apply. Plus where the SDKs and
 * the OpenAPI spec come from.
 */
export function ApiSection(): React.JSX.Element {
  return (
    <Section
      id="api"
      title="API"
      hint="everything on screen is also code"
      action={
        <Link to="/settings/api-keys" className="text-primary font-mono text-[11.5px] hover:underline">
          API keys →
        </Link>
      }
    >
      <p className="text-muted-foreground text-sm">
        Same action, three ways. All three hit the same API, so the same keys, permissions and audit log apply.
      </p>
      <Depth at="controls">
        <CodeView
          always
          title="Take down an environment, keep its data"
          tabs={THREE_WAYS}
          note={
            <>
              All three call <span className="font-mono">{THREE_WAYS_ROUTE}</span>: the same scope (write), the same policy check
              (<span className="font-mono">stack.remove</span>) and the same audit row.
            </>
          }
        />
      </Depth>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <b>SDKs</b>
        <span className="text-muted-foreground min-w-0 flex-1">
          The Go, Python and TypeScript SDKs (and the Terraform provider) take their models from the same <span className="font-mono">openapi.json</span>.
        </span>
        <a href={OPENAPI_SPEC} target="_blank" rel="noreferrer" className="text-primary font-semibold hover:underline">
          Open OpenAPI spec
        </a>
      </div>
    </Section>
  );
}
