import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { AlertRuleView, GuardrailsConfigView, IncidentDetailView, NotificationChannelView } from '@swarmy/core';
import { activityCode } from '../activity/activity-code';
import { accessCode } from '../access/access-code';
import type { PolicyRow } from '../access/use-policy-editor';
import { alertsCode } from '../alerts/alerts-code';
import { guardrailsCode } from '../guardrails/guardrails-code';
import { incidentCode } from '../incidents/incident-code';
import type { CodeTab } from './code-view';

/**
 * The Code depth may show only real REST routes and real Terraform (code.ts,
 * terraform.ts). Every call and resource the pages print is checked against
 * the committed spec and the provider's source.
 */
const ROOT = new URL('../../../../../', import.meta.url).pathname;
const spec = JSON.parse(readFileSync(`${ROOT}packages/api-rest/openapi.json`, 'utf8')) as { paths: Record<string, Record<string, unknown>> };

function routeExists(method: string, path: string): boolean {
  const clean = path.split('?')[0] ?? path;
  return Object.entries(spec.paths).some(
    ([tpl, ops]) => method.toLowerCase() in ops && new RegExp(`^${tpl.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(clean),
  );
}

function calls(tabs: CodeTab[]): string[] {
  const out: string[] = [];
  for (const { code } of tabs) {
    for (const m of code.matchAll(/curl -X (GET|POST|PUT|PATCH|DELETE) "?https:\/\/swarmy\.example\.com\/api\/v1(\/[^\s"\\]*)/g)) out.push(`${m[1]} ${m[2]}`);
    for (const m of code.matchAll(/^(GET|POST|PUT|PATCH|DELETE) \/api\/v1(\/\S*)/gm)) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/** `swarmy_x.attr` for every top-level attribute of every resource block. */
function tfAttrs(tabs: CodeTab[]): string[] {
  const out: string[] = [];
  for (const { code } of tabs) {
    for (const m of code.matchAll(/^resource "(swarmy_[a-z_]+)" "[A-Za-z0-9_-]+" \{\n([\s\S]*?)\n\}/gm)) {
      for (const a of (m[2] ?? '').matchAll(/^ {2}([a-z_]+)\s+=/gm)) out.push(`${m[1]}.${a[1]}`);
    }
  }
  return out;
}

function tfExists(ref: string): boolean {
  const [resource = '', attr = ''] = ref.split('.');
  const file = `${ROOT}terraform-provider-swarmy/internal/provider/resource_${resource.replace(/^swarmy_/, '')}.go`;
  return existsSync(file) && readFileSync(file, 'utf8').includes(`"${attr}"`);
}

const rule: AlertRuleView = {
  id: 'rule_1', name: 'Shop errors', signal: 'error-rate', selector: { app: 'shop', service: 'web' }, mutedUntil: null,
  threshold: 5, forSeconds: 300, channelIds: ['ch_1', 'ch_2'], enabled: true, isDefault: false, createdAt: '2026-11-01T00:00:00Z',
};
const channels: NotificationChannelView[] = [
  { id: 'ch_1', name: 'ops', kind: 'slack', enabled: true, target: 'hooks.slack.com', hasSecret: false, createdAt: '2026-11-01T00:00:00Z' },
  { id: 'ch_2', name: 'On-call ${phone}', kind: 'telegram', enabled: false, target: 't.me', hasSecret: true, createdAt: '2026-11-01T00:00:00Z' },
];
const guardrails: GuardrailsConfigView = {
  productionSafetyMode: true,
  rules: [
    { id: 'noLatestTagInProd', enabled: true, severity: 'block', params: {}, prodOnly: true },
    { id: 'minDbReplicasProd', enabled: true, severity: 'block', params: { n: 2 }, prodOnly: true },
  ],
};
const policies: PolicyRow[] = [
  { id: 'p_1', name: 'No production deletes', description: 'Owners only', effect: 'forbid', priority: 100, enabled: true, isDefault: false, sentence: '',
    source: JSON.stringify({ roles: ['admin'], actions: ['stack.remove'], conditions: [{ attr: 'resource.env', op: 'eq', value: 'production' }] }) },
  { id: 'p_0', name: 'Owners can do anything', description: null, effect: 'permit', priority: 0, enabled: true, isDefault: true, sentence: '', source: '{"roles":["owner"]}' },
];
const incident = {
  id: 'inc_1', title: 'shop is erroring', status: 'open', severity: 'critical', summary: null, openedAt: '2026-11-01T00:00:00Z', resolvedAt: null,
  durationSec: 60, eventCount: 1, lastEventAt: null, owner: null, events: [{ id: 'e1', at: '2026-11-01T00:00:00Z', kind: 'opened', message: 'Opened', meta: {} }],
} as IncidentDetailView;

const pages: Record<string, CodeTab[]> = {
  alerts: alertsCode(rule, [rule], channels, { enabled: true, start: '22:00', end: '07:00', timeZone: 'Europe/London', criticalPages: true, activeNow: false }),
  'alerts (no rule picked)': alertsCode(null, [rule], channels),
  guardrails: guardrailsCode(guardrails, [{ stack: 'shop', production: true, serviceCount: 2 }]),
  access: accessCode(policies, []),
  incident: incidentCode(incident),
  activity: activityCode([]),
};

describe('Code views print only real routes and resources', () => {
  for (const [page, tabs] of Object.entries(pages)) {
    test(`${page}: every REST call is in openapi.json`, () => {
      const found = calls(tabs);
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((c) => !routeExists(c.split(' ')[0] ?? '', c.split(' ')[1] ?? ''))).toEqual([]);
    });
    test(`${page}: every Terraform attribute is the provider's`, () => {
      expect(tfAttrs(tabs).filter((a) => !tfExists(a))).toEqual([]);
    });
  }
});

describe('the Terraform reads right', () => {
  const tf = (tabs: CodeTab[]) => tabs.find((t) => t.label === 'Terraform')?.code ?? '';
  test('an alert rule names its channels and takes destinations from variables', () => {
    const code = tf(pages.alerts ?? []);
    expect(code).toContain('channel_ids = [swarmy_notification_channel.ops.id, swarmy_notification_channel.on_call_phone.id]');
    expect(code).toContain('url  = var.ops_url');
    expect(code).toContain('name      = "On-call $${phone}"');
    expect(code).toContain('terraform import swarmy_alert_rule.shop_errors rule_1');
  });
  test('guardrails are one map keyed by rule', () => {
    expect(tf(pages.guardrails ?? [])).toContain('minDbReplicasProd = { enabled = true, severity = "block", params = { n = 2 } }');
  });
  test('a custom policy is a resource; a seeded default is only imported', () => {
    const code = tf(pages.access ?? []);
    expect(code).toContain('resource "swarmy_policy" "no_production_deletes"');
    expect(code).toContain('source      = jsonencode({');
    expect(code).not.toContain('resource "swarmy_policy" "owners_can_do_anything"');
    expect(code).toContain('terraform import swarmy_policy.owners_can_do_anything p_0');
  });
});
