import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BlueprintParamsInput, type BlueprintMetaView } from '@swarmy/core';
import {
  Button,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from '@swarmy/ui';
import { BlueprintOptionField, BlueprintSizePicker } from './blueprint-option-fields';

/** UI-local relaxation: an empty domain field means "no route". */
const FormSchema = BlueprintParamsInput.extend({
  domain: z.union([z.literal(''), BlueprintParamsInput.shape.domain.unwrap()]).optional(),
});
type FormValues = z.input<typeof FormSchema>;

function defaultOptions(meta: BlueprintMetaView): Record<string, string | boolean> {
  return Object.fromEntries(meta.options.map((o) => [o.key, o.defaultValue]));
}

/** Step 1 of the wizard: name, domain, size and the per-blueprint options. */
export function BlueprintParamsForm({
  meta,
  onSubmit,
}: {
  meta: BlueprintMetaView;
  onSubmit: (params: BlueprintParamsInput) => void;
}): React.JSX.Element {
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { name: '', domain: '', size: 'm', options: defaultOptions(meta) },
  });
  const size = form.watch('size') ?? 'm';
  const options = form.watch('options') ?? {};
  const setOpt = (key: string, value: string | boolean): void =>
    form.setValue('options', { ...options, [key]: value }, { shouldValidate: false });

  const submit = form.handleSubmit((values) => {
    onSubmit(
      BlueprintParamsInput.parse({
        ...values,
        domain: values.domain?.trim() ? values.domain.trim() : undefined,
      }),
    );
  });

  return (
    <Form {...form}>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="mono-label">Name</FormLabel>
              <FormControl>
                <Input placeholder="blog" className="font-mono" autoFocus {...field} />
              </FormControl>
              <p className="text-muted-foreground text-xs">
                Becomes the stack name and the prefix of everything created.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        {meta.supportsDomain ? (
          <FormField
            control={form.control}
            name="domain"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="mono-label">Domain (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="blog.example.com" className="font-mono" {...field} />
                </FormControl>
                <p className="text-muted-foreground text-xs">
                  Adds an ingress route with automatic TLS. Leave empty to skip.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
        <BlueprintSizePicker value={size} onChange={(s) => form.setValue('size', s)} />
        {meta.options.map((opt) => (
          <BlueprintOptionField
            key={opt.key}
            option={opt}
            value={options[opt.key]}
            onChange={(v) => setOpt(opt.key, v)}
          />
        ))}
        <div className="flex justify-end pt-1">
          <Button type="submit" className="rounded-full font-bold">
            Preview plan
          </Button>
        </div>
      </form>
    </Form>
  );
}
