import * as React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useFieldArray } from 'react-hook-form';
import type { z } from 'zod';
import type { CreateServiceInput } from '@swarmy/core';
import { ClipboardPasteIcon, LockIcon, LockOpenIcon, PlusIcon, VariableIcon, XIcon } from 'lucide-react';
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
  const watched = form.watch('env');
  const secretAt = (i: number): boolean => Boolean(watched?.[i]?.secret);
  const current = (): Record<string, string> =>
    Object.fromEntries((form.getValues('env') ?? []).filter((e) => e.key).map((e) => [e.key, e.value]));

  return (
    <ServiceFormSection
      title="Environment"
      caption="Config injected at runtime. Locked rows are stored as encrypted Docker secrets."
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
        onApply={(next, secretKeys) => {
          env.replace(Object.entries(next).map(([key, value]) => ({ key, value, secret: secretKeys.has(key) })));
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
            <Input
              placeholder={secretAt(i) ? 'secret value' : 'value'}
              type={secretAt(i) ? 'password' : 'text'}
              autoComplete="off"
              className="font-mono"
              {...form.register(`env.${i}.value`)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={secretAt(i) ? 'Secret — stored as a Docker secret, never shown again' : 'Mark as secret'}
              className={secretAt(i) ? 'text-status-online shrink-0' : 'text-muted-foreground shrink-0'}
              onClick={() => form.setValue(`env.${i}.secret`, !secretAt(i), { shouldDirty: true })}
            >
              {secretAt(i) ? <LockIcon className="size-4" /> : <LockOpenIcon className="size-4" />}
            </Button>
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
