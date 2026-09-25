import * as React from 'react';
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { ALL_DRIVERS, DRIVER_BLURB, DRIVER_LABELS, type IngressDriverId } from './driver-config';

export interface PreviewData {
  summary: string;
  files: { path: string; contents: string }[];
  /** In-task delivery (swarmy-run Caddy): the file lands inside the controller task. */
  localReload?: { service: string; file?: { path: string; contents: string } };
}

/** Every file the apply writes — on the host, or inside the proxy task. */
export function previewFiles(p: PreviewData): string {
  const inTask = p.localReload?.file
    ? [{ path: `${p.localReload.service}:${p.localReload.file.path}`, contents: p.localReload.file.contents }]
    : [];
  return [...p.files, ...inTask].map((f) => `# ${f.path}\n${f.contents}`).join('\n');
}

interface DriverPanelProps {
  driver: IngressDriverId;
  enabled: boolean;
  /** @deprecated the rendered config now lives at Code depth (FrontDoorCode). */
  preview?: PreviewData | undefined;
  onDriverChange: (driver: IngressDriverId) => void;
  onEnabledChange: (enabled: boolean) => void;
}

/** Which proxy runs the front door, and the master switch. The rendered config is the page's Code depth. */
export function DriverPanel({ driver, enabled, onDriverChange, onEnabledChange }: DriverPanelProps): React.JSX.Element {
  return (
    <Section title="What runs the front door">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ingress-driver" className="text-[13px]">Proxy</Label>
          <Select value={driver} onValueChange={(v) => onDriverChange(v as IngressDriverId)}>
            <SelectTrigger id="ingress-driver">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_DRIVERS.map((d) => (
                <SelectItem key={d} value={d}>
                  {DRIVER_LABELS[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{DRIVER_BLURB[driver]}</p>
        </div>
        <div className="border-border flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
          <div>
            <Label htmlFor="ingress-on" className="font-medium">Serving</Label>
            <p className="text-muted-foreground text-xs">Off writes nothing to your servers.</p>
          </div>
          <Switch id="ingress-on" checked={enabled} onCheckedChange={onEnabledChange} />
        </div>
      </div>
      <Tech>ingress driver: {driver} · None = swarmy tracks domains but writes no routing config</Tech>
    </Section>
  );
}
