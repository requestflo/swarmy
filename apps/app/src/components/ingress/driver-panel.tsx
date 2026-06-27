import * as React from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@swarmy/ui';
import { ALL_DRIVERS, DRIVER_BLURB, DRIVER_LABELS, type IngressDriverId } from './driver-config';

interface PreviewData {
  summary: string;
  files: { path: string; contents: string }[];
}

interface DriverPanelProps {
  driver: IngressDriverId;
  enabled: boolean;
  preview: PreviewData | undefined;
  onDriverChange: (driver: IngressDriverId) => void;
  onEnabledChange: (enabled: boolean) => void;
}

/** Driver chooser + master switch, paired with the rendered-config preview. */
export function DriverPanel({
  driver,
  enabled,
  preview,
  onDriverChange,
  onEnabledChange,
}: DriverPanelProps): React.JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Driver</CardTitle>
          <CardDescription>
            Choose <strong className="text-foreground">None</strong> to stay fully unopinionated —
            swarmy tracks domains for display but writes no routing config to your nodes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-1.5">
            <Label className="mono-label">Ingress driver</Label>
            <Select value={driver} onValueChange={(v) => onDriverChange(v as IngressDriverId)}>
              <SelectTrigger>
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
            <p className="text-muted-foreground mt-1 text-xs">{DRIVER_BLURB[driver]}</p>
          </div>
          <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
            <div>
              <Label htmlFor="ingress-on" className="font-medium">
                Enabled
              </Label>
              <p className="text-muted-foreground text-xs">Master switch — off writes nothing to nodes.</p>
            </div>
            <Switch id="ingress-on" checked={enabled} onCheckedChange={onEnabledChange} />
          </div>
        </CardContent>
      </Card>

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Rendered config preview</CardTitle>
          <CardDescription>What the agent would apply on ingress nodes.</CardDescription>
        </CardHeader>
        <CardContent>
          {driver === 'none' ? (
            <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-2 text-center text-sm">
              <span className="mono-label">None mode</span>
              <p>Nothing written. You&apos;re in charge of routing.</p>
            </div>
          ) : preview ? (
            <pre className="bg-muted mono-data max-h-64 overflow-auto rounded-xl p-4 text-xs">
              {preview.summary}
              {'\n\n'}
              {preview.files.map((f) => `# ${f.path}\n${f.contents}`).join('\n')}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm">No preview.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
