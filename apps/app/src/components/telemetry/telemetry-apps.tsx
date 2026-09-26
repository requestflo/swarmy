import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { QuietSwitch, plural } from '@/components/rowpage/row-page';
import { TextSkeleton } from '@/components/states';
import type { TelemetryApp } from './use-telemetry-apps';

/** "Which apps send telemetry": one switch per app, with a plain sending/off word. */
export function TelemetryApps({
  apps,
  toggle,
  pending,
  error,
  disabled,
}: {
  apps: TelemetryApp[] | undefined;
  toggle: (app: TelemetryApp, on: boolean) => void;
  pending: string | null;
  error: string | null;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <Section title="Which apps send telemetry" flush>
      <p className="text-muted-foreground -mt-1 pb-1 text-[13px] leading-snug">
        Turning it on sends traces, logs and metrics from the next deploy. No code changes, and values you set
        yourself are never overwritten.
      </p>
      <Tech className="pb-1">adds OTEL_* environment + the swarmy.otel.enabled label on the app’s services</Tech>
      {!apps ? (
        <div className="flex flex-col gap-3 py-3"><TextSkeleton className="w-3/4" /><TextSkeleton className="w-2/3" /><TextSkeleton className="w-1/2" /></div>
      ) : apps.length === 0 ? (
        <p className="text-muted-foreground py-3 text-[13px]">
          No apps yet. <Link to="/deploy" className="text-foreground underline">Deploy an app</Link> and it shows up here.
        </p>
      ) : (
        <ul className="flex flex-col">
          {apps.map((app) => (
            <li key={app.id} className="border-border flex min-h-14 items-center gap-3 border-b py-2 last:border-b-0">
              <QuietSwitch
                checked={!!app.on}
                disabled={disabled || app.on === null || pending === app.name}
                onCheckedChange={(on) => toggle(app, on)}
                aria-label={`Send telemetry from ${app.name}`}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <Link to="/stacks/$name/observability" params={{ name: app.name }} className="truncate text-[14.5px] font-semibold hover:underline">
                  {app.name}
                </Link>
                <span className="text-muted-foreground truncate font-mono text-[11px]">{plural(app.serviceCount, 'service')}</span>
              </span>
              <span className={cn('shrink-0 text-xs font-semibold', app.on ? 'text-tone-ok' : 'text-muted-foreground')}>
                {app.on === null ? '…' : pending === app.name ? 'saving' : app.on ? 'sending' : 'off'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-tone-bad py-2 text-xs">{error}</p> : null}
    </Section>
  );
}
