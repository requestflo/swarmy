import * as React from 'react';
import { Trash2Icon } from 'lucide-react';
import { Badge, Button, Input, Label, Switch, cn } from '@swarmy/ui';
import { DnsHealthBadge } from '@/components/geo/dns-health-badge';
import type { RouteDraft } from './service-ingress-panel';

interface ServiceIngressRouteRowProps {
  route: RouteDraft;
  /** Ports detected from the live service — one-tap fill for the port field. */
  detectedPorts: number[];
  disabled?: boolean;
  onChange: (patch: Partial<RouteDraft>) => void;
  onRemove: () => void;
}

/** One editable ingress route row: host + port (auto-detect) + path/strip + TLS. */
export function ServiceIngressRouteRow({
  route,
  detectedPorts,
  disabled,
  onChange,
  onRemove,
}: ServiceIngressRouteRowProps): React.JSX.Element {
  const host = route.host.trim();
  return (
    <div className="border-border space-y-3 rounded-xl border p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            value={route.host}
            placeholder="app.example.com"
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => onChange({ host: e.target.value })}
            className="mono-data"
          />
          {host && <DnsHealthBadge host={host} />}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove route"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="mono-label">Port</Label>
          <Input
            type="number"
            inputMode="numeric"
            value={route.port}
            disabled={disabled}
            onChange={(e) => onChange({ port: Number(e.target.value) || 0 })}
            className="mono-data w-24"
          />
        </div>
        {detectedPorts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pb-2">
            <span className="mono-label">detected</span>
            {detectedPorts.map((p) => (
              <button
                key={p}
                type="button"
                disabled={disabled}
                onClick={() => onChange({ port: p })}
                className={cn(
                  'mono-data rounded-full border px-2 py-0.5 text-xs transition-colors',
                  route.port === p
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <Label className="mono-label">Path (optional)</Label>
        <Input
          value={route.path ?? ''}
          placeholder="/"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => onChange({ path: e.target.value || undefined })}
          className="mono-data"
        />
        {route.path && (
          <label className="text-muted-foreground flex items-center gap-2 pt-1 text-xs">
            <Switch
              checked={!!route.stripPrefix}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ stripPrefix: v })}
            />
            Strip path prefix before proxying
          </label>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        {route.tls === 'manual' ? (
          <Badge variant="muted">manual cert</Badge>
        ) : (
          <label className="flex items-center gap-2 text-xs font-medium">
            <Switch
              checked={route.tls === 'auto'}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ tls: v ? 'auto' : 'off' })}
            />
            Automatic HTTPS
          </label>
        )}
      </div>
    </div>
  );
}
