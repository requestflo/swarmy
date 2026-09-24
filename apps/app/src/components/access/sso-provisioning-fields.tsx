import * as React from 'react';
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from '@swarmy/ui';
import type { SsoProvisioning } from './use-sso-provisioning';

interface Props {
  value: SsoProvisioning;
  onChange: (patch: Partial<SsoProvisioning>) => void;
}

/** Who gets in through this IdP, as what, and which groups they carry into access policies. */
export function SsoProvisioningFields({ value, onChange }: Props): React.JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label className="mono-label">Login button label</Label>
        <Input value={value.displayName} placeholder="e.g. Company SSO" onChange={(e) => onChange({ displayName: e.target.value })} />
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">New people join as</Label>
        <Select value={value.defaultRole} onValueChange={(v) => onChange({ defaultRole: v as 'member' | 'admin' })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-start gap-3 text-sm sm:col-span-2">
        <Switch checked={value.autoProvision} onCheckedChange={(v) => onChange({ autoProvision: v })} />
        <span>
          Let anyone in this directory sign in
          <span className="text-muted-foreground block">
            On: first sign-in creates their account and adds them here. Off: they need an invite link.
          </span>
        </span>
      </label>
      <div className="grid gap-1.5">
        <Label className="mono-label">Group claim</Label>
        <Input value={value.groupsClaim} placeholder="groups" onChange={(e) => onChange({ groupsClaim: e.target.value })} />
        <p className="text-muted-foreground text-xs">Keycloak/Authentik/Zitadel: usually <code>groups</code>. Dotted paths work.</p>
      </div>
      <div className="grid gap-1.5">
        <Label className="mono-label">Group mapping (optional)</Label>
        <Textarea
          className="mono-data min-h-20 text-xs"
          value={value.groupMapText}
          placeholder={'platform-team = developers\nsre = ops'}
          onChange={(e) => onChange({ groupMapText: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">Empty: IdP group names are used as-is. Otherwise only listed groups count.</p>
      </div>
    </div>
  );
}
