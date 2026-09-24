import * as React from 'react';
import { Input, Label, cn } from '@swarmy/ui';

export interface RelayDraft {
  host: string;
  port: string;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
  spfInclude: string;
}

export const emptyRelay: RelayDraft = { host: '', port: '587', security: 'starttls', username: '', password: '', spfInclude: '' };

/** Draft → mutation input (an empty password keeps the stored one). */
export function relayInput(r: RelayDraft) {
  return {
    host: r.host.trim(),
    port: Number(r.port) || 587,
    security: r.security,
    username: r.username.trim() || null,
    password: r.password || null,
    spfInclude: r.spfInclude.trim() || null,
  };
}

interface Props {
  delivery: 'direct' | 'relay';
  onDelivery: (d: 'direct' | 'relay') => void;
  relay: RelayDraft;
  onRelay: (r: RelayDraft) => void;
  passwordSet?: boolean;
}

const CHOICES = [
  { id: 'direct' as const, title: 'Direct', body: 'The mail node delivers to recipients itself. Needs outbound port 25 and a warmed-up IP.' },
  { id: 'relay' as const, title: 'Relay', body: 'Hand mail to any SMTP provider (smarthost). Best when port 25 is blocked or for important mail on day one.' },
];

/** Direct vs smarthost relay, and the relay's SMTP settings. */
export function DeliveryFields({ delivery, onDelivery, relay, onRelay, passwordSet }: Props): React.JSX.Element {
  const set = (k: keyof RelayDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onRelay({ ...relay, [k]: e.target.value });
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onDelivery(c.id)}
            className={cn('rounded-xl border p-3 text-left transition', delivery === c.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent')}
          >
            <p className="text-sm font-semibold">{c.title}</p>
            <p className="text-muted-foreground mt-1 text-xs">{c.body}</p>
          </button>
        ))}
      </div>
      {delivery === 'relay' ? (
        <div className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
          <Field id="relay-host" label="SMTP host" value={relay.host} onChange={set('host')} placeholder="smtp.provider.com" />
          <Field id="relay-port" label="Port" value={relay.port} onChange={set('port')} placeholder="587" />
          <div className="space-y-1">
            <Label htmlFor="relay-sec">Security</Label>
            <select id="relay-sec" className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm" value={relay.security} onChange={set('security')}>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS (465)</option>
              <option value="none">None</option>
            </select>
          </div>
          <Field id="relay-user" label="Username" value={relay.username} onChange={set('username')} />
          <Field id="relay-pass" label={passwordSet ? 'Password (set — leave empty to keep)' : 'Password'} value={relay.password} onChange={set('password')} type="password" />
          <Field id="relay-spf" label="SPF include (from your provider)" value={relay.spfInclude} onChange={set('spfInclude')} placeholder="spf.provider.com" />
        </div>
      ) : null}
    </div>
  );
}

function Field(p: { id: string; label: string; value: string; onChange: React.ChangeEventHandler<HTMLInputElement>; placeholder?: string; type?: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={p.id}>{p.label}</Label>
      <Input id={p.id} type={p.type} value={p.value} onChange={p.onChange} placeholder={p.placeholder} />
    </div>
  );
}
