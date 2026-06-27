import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useFieldArray } from 'react-hook-form';
import type { z } from 'zod';
import type { CreateServiceInput } from '@swarmy/core';
import { NetworkIcon, PlusIcon, XIcon } from 'lucide-react';
import { Button, EmptyState, Input } from '@swarmy/ui';
import { ServiceFormSection } from '@/components/services/service-form-section';

type FormValues = z.input<typeof CreateServiceInput>;

interface ServicePortFieldsProps {
  form: UseFormReturn<FormValues>;
}

/** Repeatable published → target port mappings. */
export function ServicePortFields({ form }: ServicePortFieldsProps): React.JSX.Element {
  const ports = useFieldArray({ control: form.control, name: 'ports' });

  return (
    <ServiceFormSection
      title="Ports"
      caption="Expose container ports to the cluster."
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full font-bold"
          onClick={() => ports.append({ target: 80, protocol: 'tcp', mode: 'ingress' })}
        >
          <PlusIcon className="size-4" /> Add
        </Button>
      }
    >
      {ports.fields.length === 0 ? (
        <EmptyState
          icon={<NetworkIcon />}
          title="No published ports"
          description="Add a mapping to expose a container port to traffic."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full font-bold"
              onClick={() => ports.append({ target: 80, protocol: 'tcp', mode: 'ingress' })}
            >
              <PlusIcon className="size-4" /> Add port
            </Button>
          }
        />
      ) : (
        ports.fields.map((f, i) => (
          <div key={f.id} className="flex items-center gap-2">
            <Input
              type="number"
              placeholder="published"
              className="mono-data"
              {...form.register(`ports.${i}.published`, { valueAsNumber: true })}
            />
            <span className="text-primary mono-label">→</span>
            <Input
              type="number"
              placeholder="target"
              className="mono-data"
              {...form.register(`ports.${i}.target`, { valueAsNumber: true })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-status-offline shrink-0"
              onClick={() => ports.remove(i)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        ))
      )}
    </ServiceFormSection>
  );
}
