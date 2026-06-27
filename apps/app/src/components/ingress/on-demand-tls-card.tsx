import * as React from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@swarmy/ui';

interface OnDemandTlsCardProps {
  onSave: (askUrl: string) => void;
  onDisable: () => void;
  pending: boolean;
}

/** On-demand TLS for custom domains, gated by an ask endpoint. */
export function OnDemandTlsCard({ onSave, onDisable, pending }: OnDemandTlsCardProps): React.JSX.Element {
  const [askUrl, setAskUrl] = React.useState('');
  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">On-demand TLS — custom domains</CardTitle>
        <CardDescription>
          Issue certificates on first request, gated by an <strong>ask</strong> endpoint so only
          domains registered to your org get a cert. Point it at the controller&apos;s{' '}
          <code className="mono-data">/ingress/ask</code> route.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1.5">
          <Label className="mono-label">Ask endpoint URL</Label>
          <div className="flex gap-2">
            <Input
              value={askUrl}
              onChange={(e) => setAskUrl(e.target.value)}
              placeholder="https://controller.example.com/ingress/ask"
            />
            <Button onClick={() => onSave(askUrl)} disabled={pending || !askUrl}>
              Enable
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">
              Deny-by-default: unknown hostnames never trigger issuance.
            </p>
            <Button variant="ghost" size="sm" onClick={onDisable} disabled={pending}>
              Disable
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
