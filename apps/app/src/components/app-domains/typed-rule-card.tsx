import * as React from 'react';
import { useDepth } from '@/components/calm';
import type { RouteProtection } from '@/components/ingress/protection-model';
import { ProtectionCard, RuleFields } from './protection-card';
import { isOn, patch, ruleSay, switchedOff, tokens } from './protection-rules';

type TypedRule = 'countries' | 'ips' | 'size';

const TITLE: Record<TypedRule, string> = { countries: 'Countries', ips: 'IP rules', size: 'Max upload size' };

/** The two (or one) things you type for each rule, seeded from what is saved. */
function seed(p: RouteProtection | null, id: TypedRule): string[] {
  if (id === 'countries') return [(p?.countryDeny ?? []).join(', '), (p?.countryAllow ?? []).join(', ')];
  if (id === 'ips') return [(p?.ipDeny ?? []).join(' '), (p?.ipAllow ?? []).join(' ')];
  return [p?.bodyMaxSize ?? ''];
}

function next(p: RouteProtection | null, id: TypedRule, v: string[]): RouteProtection | null {
  if (id === 'countries') return patch(p, { countryDeny: tokens(v[0] ?? ''), countryAllow: tokens(v[1] ?? '') });
  if (id === 'ips') return patch(p, { ipDeny: tokens(v[0] ?? ''), ipAllow: tokens(v[1] ?? '') });
  return patch(p, { bodyMaxSize: v[0]?.trim() || undefined });
}

const FIELDS: Record<TypedRule, Array<{ label: string; placeholder: string }>> = {
  countries: [{ label: 'Turn away countries', placeholder: 'RU, KP' }, { label: 'Only allow countries', placeholder: 'empty = everyone else' }],
  ips: [{ label: 'Turn away addresses', placeholder: '45.155.205.0/24' }, { label: 'Only allow addresses', placeholder: 'empty = everyone else' }],
  size: [{ label: 'Largest upload', placeholder: '10MB' }],
};

function techOf(p: RouteProtection | null, id: TypedRule): string {
  if (id === 'countries') return 'maxmind_geolocation matcher → abort · deny before allow · enforced only when the edge has a country database';
  if (id === 'ips') return `remote_ip ${[...(p?.ipDeny ?? []), ...(p?.ipAllow ?? [])].join(' ') || '…'} → abort · deny before allow`;
  return `request_body { max_size ${p?.bodyMaxSize ?? '…'} } → 413`;
}

/** Countries, IP rules and upload size: switch off clears the rule; switch on asks what to enforce. */
export function TypedRuleCard({ id, protection: p, service, saving, save }: {
  id: TypedRule;
  protection: RouteProtection | null;
  service: string;
  saving: boolean;
  save: (next: RouteProtection | null, done?: string) => void;
}): React.JSX.Element {
  const controls = useDepth().depth !== 'summary';
  const on = isOn(p, id);
  const [editing, setEditing] = React.useState(false);
  const [values, setValues] = React.useState(() => seed(p, id));
  const key = JSON.stringify(seed(p, id));
  React.useEffect(() => setValues(JSON.parse(key) as string[]), [key]);
  return (
    <ProtectionCard
      title={TITLE[id]}
      on={on || editing}
      disabled={saving}
      onToggle={(v) => {
        if (v) setEditing(true);
        else if (editing && !on) setEditing(false);
        else save(switchedOff(p, id), `${TITLE[id]} off`);
      }}
      say={ruleSay(p, id, service)}
      tech={techOf(p, id)}
    >
      {editing || controls ? (
        <RuleFields
          saving={saving}
          fields={FIELDS[id].map((f, i) => ({ ...f, value: values[i] ?? '', onChange: (v) => setValues((xs) => xs.map((x, k) => (k === i ? v : x))) }))}
          onSave={() => {
            save(next(p, id, values), `${TITLE[id]} saved`);
            setEditing(false);
          }}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
      ) : null}
    </ProtectionCard>
  );
}
