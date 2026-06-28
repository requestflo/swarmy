import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import type { CreateServiceInput, TlsMode } from '@swarmy/core';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from '@swarmy/ui';
import { ServiceFormSection } from '@/components/services/service-form-section';

type FormValues = z.input<typeof CreateServiceInput>;

interface ServiceIngressFieldsProps {
  form: UseFormReturn<FormValues>;
}

/** Optional public exposure via the ingress controller. */
export function ServiceIngressFields({ form }: ServiceIngressFieldsProps): React.JSX.Element {
  const ingressEnabled = form.watch('ingress.enabled');
  const tls = form.watch('ingress.tls') ?? 'auto';

  return (
    <ServiceFormSection title="Ingress" caption="Reach it from the public internet.">
      <div className="bg-accent/50 flex items-center justify-between rounded-xl px-4 py-3">
        <div className="min-w-0">
          <Label htmlFor="ingress-enabled" className="text-sm font-semibold">
            Expose via ingress
          </Label>
          <p className="text-muted-foreground text-xs">Route a domain to this service with TLS.</p>
        </div>
        <Switch
          id="ingress-enabled"
          checked={!!ingressEnabled}
          onCheckedChange={(v) => form.setValue('ingress.enabled', v)}
        />
      </div>

      <div
        className={cn(
          'grid gap-3 sm:grid-cols-[1fr_auto_auto]',
          !ingressEnabled && 'pointer-events-none opacity-40',
        )}
      >
        <div className="grid gap-1.5">
          <Label className="mono-label">Domain</Label>
          <Input
            placeholder="app.example.com"
            className="font-mono"
            disabled={!ingressEnabled}
            {...form.register('ingress.domain')}
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Target port</Label>
          <Input
            type="number"
            placeholder="8080"
            className="mono-data sm:w-32"
            disabled={!ingressEnabled}
            {...form.register('ingress.targetPort', {
              setValueAs: (v) => (v === '' || v == null ? undefined : Number(v)),
            })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">TLS</Label>
          <Select
            value={tls}
            disabled={!ingressEnabled}
            onValueChange={(v) => form.setValue('ingress.tls', v as TlsMode)}
          >
            <SelectTrigger className="sm:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </ServiceFormSection>
  );
}
