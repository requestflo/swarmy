import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { CopyButton } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { CLI_COMMANDS, cliInstall } from './cli-mcp';

/** A terminal block with a copy button (the copy drops the `$ ` prompts). */
export function Terminal({ code, label }: { code: string; label: string }): React.JSX.Element {
  return (
    <div className="relative min-w-0">
      <pre tabIndex={0} aria-label={label} className="calm-code overflow-x-auto px-4 py-3 pr-12 whitespace-pre">
        {code}
      </pre>
      <CopyButton value={code.replace(/^\$ /gm, '')} className="absolute top-2 right-2 size-8" />
    </div>
  );
}

/** "swarmy CLI" (board 67): install + sign in against this controller, then the commands people use most. */
export function CliSection({ origin }: { origin: string }): React.JSX.Element {
  return (
    <Section title="swarmy CLI" hint="talks to /api/v1">
      <Terminal code={cliInstall(origin)} label="Install and sign in" />
      <ul className="flex flex-col">
        {CLI_COMMANDS.map((c) => (
          <li key={c.cmd} className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b py-2 last:border-b-0">
            <span className="w-44 shrink-0 font-mono text-[12.5px] font-medium [font-variant-ligatures:none]">{c.cmd}</span>
            <span className="text-muted-foreground min-w-0 flex-1 text-[13px]">{c.say}</span>
          </li>
        ))}
      </ul>
      <Tech className="[font-variant-ligatures:none]">swarmy help · login · whoami · link · deploy --preview · env push · errors dsn · sourcemaps upload · remove</Tech>
      <p className="text-muted-foreground text-xs">
        Signing in opens your browser; you approve it on{' '}
        <Link to="/device" className="text-foreground underline underline-offset-2">
          the device page
        </Link>
        , with SSO if your workspace uses it.
      </p>
    </Section>
  );
}
