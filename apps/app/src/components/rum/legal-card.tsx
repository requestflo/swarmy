import * as React from 'react';
import { TriangleAlertIcon } from 'lucide-react';

/** The honest version: self-hosting moves the data, not the duties. */
export function LegalCard(): React.JSX.Element {
  return (
    <section className="calm-card shadow-none border-status-warning/35 flex flex-col gap-1.5 border p-5">
      <span className="text-tone-warn flex items-center gap-2 text-sm font-bold">
        <TriangleAlertIcon className="size-4" /> Self-hosted isn't the same as consent-free
      </span>
      <p className="text-muted-foreground text-sm leading-relaxed">
        It keeps data away from Google, but not your duties: ePrivacy covers anything stored on or read
        from a visitor's device, GDPR covers personal data. Replays and identified analytics are personal
        data — you need a legal basis or consent (that's the consent hook). Only cookieless aggregate
        analytics is plausibly banner-free. <span className="font-semibold">Not legal advice.</span>
      </p>
    </section>
  );
}
