import * as React from 'react';
import {
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@swarmy/ui';
import type { ServiceModelOut } from '@swarmy/core/compose';
import { ImagePicker } from './image-picker';
import { KvEditor } from './kv-editor';
import { ListEditor } from './list-editor';
import { PortsEditor } from './ports-editor';
import { MountsEditor } from './mounts-editor';
import { SchedulingTab } from './scheduling-tab';
import type { ServiceModelState } from './use-service-model';

interface ServiceBuilderProps {
  state: ServiceModelState;
}

/** The visual, model-driven service builder. Tabs map onto ServiceModel fields. */
export function ServiceBuilder({ state }: ServiceBuilderProps): React.JSX.Element {
  const { model, set } = state;
  return (
    <Card className="card-pop border-0">
      <CardContent className="pt-6">
        <Tabs defaultValue="general">
          <TabsList className="mb-4 flex-wrap">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="env">Env</TabsTrigger>
            <TabsTrigger value="networking">Networking</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            <TabsTrigger value="scheduling">Scheduling</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="grid gap-4">
            <Field label="Name">
              <Input
                placeholder="api"
                value={model.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </Field>
            <Field label="Image">
              <ImagePicker value={model.image} onChange={(v) => set('image', v)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Mode">
                <Select value={model.mode} onValueChange={(v) => set('mode', v as 'replicated' | 'global')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="replicated">replicated</SelectItem>
                    <SelectItem value="global">global</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {model.mode === 'replicated' && (
                <Field label="Replicas">
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    className="mono-data"
                    value={model.replicas}
                    onChange={(e) => set('replicas', Number(e.target.value))}
                  />
                </Field>
              )}
            </div>
            <Field label="Command">
              <ListEditor
                value={model.command}
                onChange={(v) => set('command', v)}
                placeholder="arg"
                emptyHint="Uses the image's default command."
              />
            </Field>
          </TabsContent>

          <TabsContent value="env" className="grid gap-4">
            <Field label="Environment">
              <KvEditor value={model.env} onChange={(v) => set('env', v)} emptyHint="No env yet." />
            </Field>
            <Field label="Labels">
              <KvEditor
                value={model.labels}
                onChange={(v) => set('labels', v)}
                keyPlaceholder="com.example.key"
                emptyHint="No labels."
              />
            </Field>
          </TabsContent>

          <TabsContent value="networking" className="grid gap-4">
            <Field label="Ports">
              <PortsEditor value={model.ports} onChange={(v) => set('ports', v)} />
            </Field>
            <Field label="Networks">
              <ListEditor
                value={model.networks}
                onChange={(v) => set('networks', v)}
                placeholder="frontend"
                emptyHint="Default overlay network."
              />
            </Field>
          </TabsContent>

          <TabsContent value="storage" className="grid gap-4">
            <Field label="Mounts">
              <MountsEditor value={model.mounts} onChange={(v) => set('mounts', v)} />
            </Field>
          </TabsContent>

          <TabsContent value="scheduling">
            <SchedulingTab model={model} set={set} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <Label className="mono-label">{label}</Label>
      {children}
    </div>
  );
}
