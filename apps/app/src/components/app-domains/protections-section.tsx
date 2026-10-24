import * as React from 'react';
import { Section } from '@/components/calm';
import { Segmented } from '@/components/domains/segmented';
import type { RouteProtection } from '@/components/ingress/protection-model';
import type { HostBlocked } from '@/lib/host-blocked';
import { BlockedReceipt } from './blocked-receipt';
import { PasswordCard } from './password-card';
import { ProtectionCard } from './protection-card';
import { RATE_PRESETS, isOn, ruleSay, rulesOn, switchedOff, switchedOn, withRate } from './protection-rules';
import { TypedRuleCard } from './typed-rule-card';

interface Props {
  host: string;
  service: string;
  protection: RouteProtection | null;
  /** This address's 403 + 429 a minute at the edge; null = no honest number. */
  blocked: HostBlocked | null;
  saving: boolean;
  save: (next: RouteProtection | null, done?: string) => void;
}

/**
 * Protections (board 30): each rule the front door enforces before a request
 * reaches the service, as a card with its switch. Saved on the route's
 * `swarmy.ingress.routes` label; Caddy on every edge applies it. Above the
 * cards, the receipt: what the edge blocked at this address (never split by
 * card — no metric label says which rule answered).
 */
export function ProtectionsSection({ host, service, protection: p, blocked, saving, save }: Props): React.JSX.Element {
  const rate = p?.rateLimit;
  const preset = rate && rate.windowSeconds === 60 && (RATE_PRESETS as readonly number[]).includes(rate.requests) ? String(rate.requests) : '';
  const simple = (id: 'rate' | 'bots' | 'scanners', title: string) => (on: boolean) =>
    save(on ? switchedOn(p, id) : switchedOff(p, id), `${title} ${on ? 'on' : 'off'}`);
  const n = rulesOn(p);
  return (
    <Section title="Protections" count={`${n} on`} hint={`Enforced at the front door before a request reaches ${service}.`}>
      <BlockedReceipt blocked={blocked} host={host} service={service} />
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        <ProtectionCard
          title="Rate limit"
          on={isOn(p, 'rate')}
          disabled={saving}
          onToggle={simple('rate', 'Rate limit')}
          say={ruleSay(p, 'rate', service)}
          tech={rate ? `rate_limit · events ${rate.requests} · window ${rate.windowSeconds}s · key ${rate.key === 'header' && rate.header ? `{header.${rate.header}}` : '{remote_host}'}` : 'rate_limit (mholt/caddy-ratelimit, swarmy’s Caddy build) · off'}
        >
          <Segmented
            label="Requests a minute per visitor"
            mono
            value={preset}
            disabled={saving}
            options={RATE_PRESETS.map((r) => ({ value: String(r), label: `${r}/min` }))}
            onChange={(v) => save(withRate(p, Number(v)), `Rate limit: ${v} a minute`)}
          />
        </ProtectionCard>
        <ProtectionCard
          title="Block bots & scanners"
          on={isOn(p, 'bots')}
          disabled={saving}
          onToggle={simple('bots', 'Bot blocking')}
          say={ruleSay(p, 'bots', service)}
          tech="header_regexp User-Agent (?i)(bot|crawler|spider|scan) → abort"
        />
        <ProtectionCard
          title="Scanner paths"
          on={isOn(p, 'scanners')}
          disabled={saving}
          onToggle={simple('scanners', 'Scanner paths')}
          say={ruleSay(p, 'scanners', service)}
          tech="WAF-lite · path /wp-login.php /.env* /.git/* /phpmyadmin* /vendor/phpunit/* /cgi-bin/* … → 403"
        />
        <TypedRuleCard key={`c-${host}`} id="countries" protection={p} service={service} saving={saving} save={save} />
        <TypedRuleCard key={`i-${host}`} id="ips" protection={p} service={service} saving={saving} save={save} />
        <TypedRuleCard key={`s-${host}`} id="size" protection={p} service={service} saving={saving} save={save} />
        <PasswordCard key={`p-${host}`} protection={p} service={service} saving={saving} save={save} />
      </div>
    </Section>
  );
}
