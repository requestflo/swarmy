import * as React from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@swarmy/ui';
import { DRIVER_LABELS } from './driver-config';

/** TLS note for drivers without built-in ACME (nginx / haproxy). */
export function ExternalAcmeNoticeCard({
  driver,
}: {
  driver: 'nginx' | 'haproxy';
}): React.JSX.Element {
  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">{DRIVER_LABELS[driver]} — TLS note</CardTitle>
        <CardDescription>
          {DRIVER_LABELS[driver]} has no built-in ACME. For <code className="mono-data">auto</code>{' '}
          TLS, run an external companion (certbot / acme.sh) that drops certs at the conventional
          path; swarmy renders the proxy config to read them. Or use <strong>custom</strong> TLS and
          supply the cert material. Want automatic HTTPS with zero setup? Switch to Caddy.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
