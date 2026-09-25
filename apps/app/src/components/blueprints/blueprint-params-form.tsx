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
import { useOnlineNodeCount } from '@/lib/use-online-node-count';
import { PrivateHostNote } from '@/components/ingress/private-host-note';
import { Depth, Tech } from '@/components/calm';
import { defaultAppName, getsAutoAddress } from './template-words';
import {
  BlueprintOptionField,
  BlueprintSizePicker,
  defaultSizeForNodes,
} from './blueprint-option-fields';

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
  const onlineNodes = useOnlineNodeCount();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      name: defaultAppName(meta),
      domain: '',
      size: defaultSizeForNodes(onlineNodes),
      options: defaultOptions(meta),
    },
  });
  // The nodes list may land after mount: follow it until the user picks a size.
  const sizeTouched = React.useRef(false);
  React.useEffect(() => {
    if (!sizeTouched.current) form.setValue('size', defaultSizeForNodes(onlineNodes));
  }, [form, onlineNodes]);

  const size = form.watch('size') ?? 'm';
  const domain = form.watch('domain') ?? '';
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
              <FormLabel>App name</FormLabel>
              <FormControl>
                <Input placeholder="blog" className="font-mono" {...field} />
              </FormControl>
              <p className="text-muted-foreground text-xs">Used in addresses and logs. Lowercase, no spaces.</p>
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
                <FormLabel>Your own domain (optional)</FormLabel>
                <FormControl>
                  <Input placeholder="blog.example.com" className="font-mono" {...field} />
                </FormControl>
                <p className="text-muted-foreground text-xs">
                  {getsAutoAddress(meta)
                    ? 'Leave it empty and it gets a web address straight away, with HTTPS. Add a domain any time.'
                    : 'HTTPS at this address, set up for you. Leave it empty to skip.'}
                </p>
                <PrivateHostNote host={domain} />
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
        <Tech>
          size {size} · {Object.keys(options).length} option{Object.keys(options).length === 1 ? '' : 's'} · secrets generated at deploy
        </Tech>
        <Depth at="controls">
          <BlueprintSizePicker
            value={size}
            onlineNodes={onlineNodes}
            onChange={(s) => {
              sizeTouched.current = true;
              form.setValue('size', s);
            }}
          />
          {meta.options.map((opt) => (
            <BlueprintOptionField
              key={opt.key}
              option={opt}
              value={options[opt.key]}
              onChange={(v) => setOpt(opt.key, v)}
            />
          ))}
        </Depth>
        <div className="flex justify-end pt-1">
          <Button type="submit" className="w-full rounded-full font-bold pointer-coarse:min-h-11 sm:w-auto">
            Review {meta.name}
          </Button>
        </div>
      </form>
    </Form>
  );
}
