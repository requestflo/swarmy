import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Loader2Icon, PlusIcon, XIcon } from 'lucide-react';
import { CreateServiceInput } from '@swarmy/core';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/services/new')({
  component: NewServicePage,
});

type FormValues = z.input<typeof CreateServiceInput>;

function NewServicePage() {
  const trpc = useTRPC();
  const navigate = useNavigate();

  const form = useForm<FormValues>({
    resolver: zodResolver(CreateServiceInput),
    defaultValues: {
      name: '',
      image: '',
      replicas: 1,
      command: [],
      env: [],
      ports: [],
      volumes: [],
      networks: [],
      constraints: [],
      ingress: { enabled: false, tls: 'auto' },
    },
  });

  const env = useFieldArray({ control: form.control, name: 'env' });
  const ports = useFieldArray({ control: form.control, name: 'ports' });
  const ingressEnabled = form.watch('ingress.enabled');

  const create = useMutation(
    trpc.services.create.mutationOptions({
      onSuccess: (res) => {
        toast.success('Service deploying');
        void navigate({ to: '/services/$serviceId', params: { serviceId: res.id } });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const submit = form.handleSubmit((values) => {
    create.mutate(values as typeof CreateServiceInput._output);
  });

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New service" description="Deploy a container image to the swarm." />
      <Form {...form}>
        <form onSubmit={submit} className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Service</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="api" {...field} />
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
                    <FormLabel>Image</FormLabel>
                    <FormControl>
                      <Input placeholder="nginx:latest" {...field} />
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
                    <FormLabel>Replicas</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={1000}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Environment
                <Button type="button" variant="outline" size="sm" onClick={() => env.append({ key: '', value: '' })}>
                  <PlusIcon className="size-4" /> Add
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {env.fields.map((f, i) => (
                <div key={f.id} className="flex items-center gap-2">
                  <Input placeholder="KEY" {...form.register(`env.${i}.key`)} className="font-mono" />
                  <Input placeholder="value" {...form.register(`env.${i}.value`)} className="font-mono" />
                  <Button type="button" variant="ghost" size="icon" onClick={() => env.remove(i)}>
                    <XIcon className="size-4" />
                  </Button>
                </div>
              ))}
              {env.fields.length === 0 && (
                <p className="text-muted-foreground text-sm">No environment variables.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Ports
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => ports.append({ target: 80, protocol: 'tcp', mode: 'ingress' })}
                >
                  <PlusIcon className="size-4" /> Add
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {ports.fields.map((f, i) => (
                <div key={f.id} className="flex items-center gap-2">
                  <Input
                    type="number"
                    placeholder="published"
                    {...form.register(`ports.${i}.published`, { valueAsNumber: true })}
                  />
                  <span className="text-muted-foreground">→</span>
                  <Input
                    type="number"
                    placeholder="target"
                    {...form.register(`ports.${i}.target`, { valueAsNumber: true })}
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => ports.remove(i)}>
                    <XIcon className="size-4" />
                  </Button>
                </div>
              ))}
              {ports.fields.length === 0 && <p className="text-muted-foreground text-sm">No published ports.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ingress</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="ingress-enabled">Expose via ingress</Label>
                <Switch
                  id="ingress-enabled"
                  checked={!!ingressEnabled}
                  onCheckedChange={(v) => form.setValue('ingress.enabled', v)}
                />
              </div>
              {ingressEnabled && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input placeholder="app.example.com" {...form.register('ingress.domain')} />
                  <Input
                    type="number"
                    placeholder="target port"
                    {...form.register('ingress.targetPort', { valueAsNumber: true })}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate({ to: '/services' })}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2Icon className="animate-spin" />}
              Deploy
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
