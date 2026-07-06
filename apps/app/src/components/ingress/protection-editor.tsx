import * as React from 'react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@swarmy/ui';
import { fromDraft, toDraft, type ProtectionDraft, type RouteProtection } from './protection-model';

interface ProtectionEditorProps {
  initial: RouteProtection | null;
  saving: boolean;
  onSave: (protection: RouteProtection | null) => void;
  onCancel: () => void;
}

/** Inline per-route protection editor — rate limit, IP rules, body cap, bots, headers. */
export function ProtectionEditor({ initial, saving, onSave, onCancel }: ProtectionEditorProps): React.JSX.Element {
  const [d, setD] = React.useState<ProtectionDraft>(() => toDraft(initial));
  const patch = (p: Partial<ProtectionDraft>): void => setD((prev) => ({ ...prev, ...p }));

  return (
    <div className="bg-accent/30 grid gap-4 border-t px-6 py-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2 pb-2">
          <Switch id="rl-on" checked={d.rateLimitOn} onCheckedChange={(v) => patch({ rateLimitOn: v })} />
          <Label htmlFor="rl-on" className="font-medium">Rate limit</Label>
        </div>
        {d.rateLimitOn ? (
          <>
            <Field label="Requests">
              <Input type="number" min={1} className="w-24" value={d.requests} onChange={(e) => patch({ requests: Number(e.target.value) })} />
            </Field>
            <Field label="Window (s)">
              <Input type="number" min={1} className="w-24" value={d.windowSeconds} onChange={(e) => patch({ windowSeconds: Number(e.target.value) })} />
            </Field>
            <Field label="Key by">
              <Select value={d.key} onValueChange={(v) => patch({ key: v as 'ip' | 'header' })}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ip">Client IP</SelectItem>
                  <SelectItem value="header">Header</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {d.key === 'header' ? (
              <Field label="Header">
                <Input className="w-40" placeholder="X-Api-Key" value={d.header} onChange={(e) => patch({ header: e.target.value })} />
              </Field>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Allow IPs / CIDRs (one per line — empty allows all)">
          <Textarea rows={3} className="mono-data" placeholder={'10.0.0.0/8'} value={d.ipAllow} onChange={(e) => patch({ ipAllow: e.target.value })} />
        </Field>
        <Field label="Deny IPs / CIDRs (one per line)">
          <Textarea rows={3} className="mono-data" placeholder={'203.0.113.7'} value={d.ipDeny} onChange={(e) => patch({ ipDeny: e.target.value })} />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Max body size">
          <Input className="w-28" placeholder="10MB" value={d.bodyMaxSize} onChange={(e) => patch({ bodyMaxSize: e.target.value })} />
        </Field>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="bots-off" checked={d.blockBots} onCheckedChange={(v) => patch({ blockBots: v })} />
          <Label htmlFor="bots-off" className="font-medium">Block bots &amp; scanners</Label>
        </div>
      </div>

      <Field label="Required headers (one per line — Header or Header: value)">
        <Textarea rows={2} className="mono-data" placeholder={'X-Api-Key\nX-Env: prod'} value={d.requiredHeaders} onChange={(e) => patch({ requiredHeaders: e.target.value })} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Allow countries (ISO codes, comma-separated — empty allows all)">
          <Input className="mono-data" placeholder="GB, IE" value={d.countryAllow} onChange={(e) => patch({ countryAllow: e.target.value })} />
        </Field>
        <Field label="Deny countries (ISO codes, comma-separated)">
          <Input className="mono-data" placeholder="RU, KP" value={d.countryDeny} onChange={(e) => patch({ countryDeny: e.target.value })} />
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2 pb-2">
          <Switch id="cache-on" checked={d.cacheOn} onCheckedChange={(v) => patch({ cacheOn: v })} />
          <Label htmlFor="cache-on" className="font-medium">Cache responses</Label>
        </div>
        {d.cacheOn ? (
          <>
            <Field label="TTL (s)">
              <Input type="number" min={1} max={86400} className="w-24" value={d.cacheTtlSeconds} onChange={(e) => patch({ cacheTtlSeconds: Number(e.target.value) })} />
            </Field>
            <Field label="Serve stale for (s)">
              <Input type="number" min={1} className="w-28" placeholder="off" value={d.cacheStaleSeconds} onChange={(e) => patch({ cacheStaleSeconds: e.target.value })} />
            </Field>
            <Field label="Key headers (comma-separated)">
              <Input className="w-56 mono-data" placeholder="Accept-Language" value={d.cacheKeyHeaders} onChange={(e) => patch({ cacheKeyHeaders: e.target.value })} />
            </Field>
          </>
        ) : null}
      </div>

      <div className="grid gap-3">
        <div className="flex items-center gap-2">
          <Switch id="waf-on" checked={d.wafOn} onCheckedChange={(v) => patch({ wafOn: v })} />
          <Label htmlFor="waf-on" className="font-medium">WAF-lite</Label>
        </div>
        {d.wafOn ? (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex items-center gap-2 pb-2">
                <Switch id="waf-scan" checked={d.wafScannerPaths} onCheckedChange={(v) => patch({ wafScannerPaths: v })} />
                <Label htmlFor="waf-scan" className="font-medium">Block known scanner paths</Label>
              </div>
              <Field label="Block methods (comma-separated)">
                <Input className="w-48 mono-data" placeholder="TRACE, DELETE" value={d.wafMethods} onChange={(e) => patch({ wafMethods: e.target.value })} />
              </Field>
            </div>
            <Field label="Deny query patterns (one regex per line — matching requests get 403)">
              <Textarea rows={2} className="mono-data" placeholder={'(?i)union.*select\n\\.\\./'} value={d.wafQueryPatterns} onChange={(e) => patch({ wafQueryPatterns: e.target.value })} />
            </Field>
          </>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="outline" size="sm" onClick={() => onSave(fromDraft(d))} disabled={saving}>
          {saving ? 'Saving…' : 'Save protections'}
        </Button>
      </div>
    </div>
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
