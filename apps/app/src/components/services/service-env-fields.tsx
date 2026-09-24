import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useFieldArray } from 'react-hook-form';
import type { z } from 'zod';
import type { CreateServiceInput } from '@swarmy/core';
import { ClipboardPasteIcon, PlusIcon, VariableIcon, XIcon } from 'lucide-react';
import { Button, EmptyState, Input } from '@swarmy/ui';
import { ServiceFormSection } from '@/components/services/service-form-section';
import { EnvPasteDialog, SERVICE_ENV_PARSE } from '@/components/env/env-paste-dialog';

type FormValues = z.input<typeof CreateServiceInput>;

interface ServiceEnvFieldsProps {
  form: UseFormReturn<FormValues>;
}

/** Repeatable KEY=value environment pairs. */
export function ServiceEnvFields({ form }: ServiceEnvFieldsProps): React.JSX.Element {
  const env = useFieldArray({ control: form.control, name: 'env' });
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const current = (): Record<string, string> =>
    Object.fromEntries((form.getValues('env') ?? []).filter((e) => e.key).map((e) => [e.key, e.value]));

  return (
    <ServiceFormSection
      title="Environment"
      caption="Config and secrets injected at runtime."
      action={
        <span className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full font-bold"
          onClick={() => setPasteOpen(true)}
        >
          <ClipboardPasteIcon className="size-4" /> Paste .env
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full font-bold"
          onClick={() => env.append({ key: '', value: '' })}
        >
          <PlusIcon className="size-4" /> Add
        </Button>
        </span>
      }
    >
      <EnvPasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        current={pasteOpen ? current() : {}}
        parseOptions={SERVICE_ENV_PARSE}
        onApply={(next) => {
          env.replace(Object.entries(next).map(([key, value]) => ({ key, value })));
          setPasteOpen(false);
        }}
      />
      {env.fields.length === 0 ? (
        <EmptyState
          icon={<VariableIcon />}
          title="No environment variables"
          description="Add a key when your service needs config or a secret."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full font-bold"
              onClick={() => env.append({ key: '', value: '' })}
            >
              <PlusIcon className="size-4" /> Add variable
            </Button>
          }
        />
      ) : (
        env.fields.map((f, i) => (
          <div key={f.id} className="flex items-center gap-2">
            <Input placeholder="KEY" className="font-mono" {...form.register(`env.${i}.key`)} />
            <span className="text-muted-foreground mono-label">=</span>
            <Input placeholder="value" className="font-mono" {...form.register(`env.${i}.value`)} />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-status-offline shrink-0"
              onClick={() => env.remove(i)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        ))
      )}
    </ServiceFormSection>
  );
}
