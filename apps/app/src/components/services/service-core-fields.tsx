import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import type { CreateServiceInput } from '@swarmy/core';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from '@swarmy/ui';
import { ServiceFormSection } from '@/components/services/service-form-section';

type FormValues = z.input<typeof CreateServiceInput>;

interface ServiceCoreFieldsProps {
  form: UseFormReturn<FormValues>;
}

/** Name / image / replicas — the identity of the service being deployed. */
export function ServiceCoreFields({ form }: ServiceCoreFieldsProps): React.JSX.Element {
  return (
    <ServiceFormSection title="Service" caption="What we roll out across the swarm.">
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="mono-label">Name</FormLabel>
            <FormControl>
              <Input placeholder="api" className="font-mono" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="image"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="mono-label">Image</FormLabel>
            <FormControl>
              <Input placeholder="nginx:latest" className="font-mono" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="replicas"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="mono-label">Replicas</FormLabel>
            <FormControl>
              <Input
                type="number"
                min={0}
                max={1000}
                className="mono-data"
                {...field}
                onChange={(e) => field.onChange(Number(e.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </ServiceFormSection>
  );
}
