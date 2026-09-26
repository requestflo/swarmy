import type { PublicStatusView, StatusPageView } from '@swarmy/core';
import { type CodeTab } from '@/components/calm';
import { API_BASE } from '@/components/calm/code';

/** Code depth: the public JSON (real, no key needed) and the tRPC calls the dashboard makes. */
export function statusPagesCode(page: StatusPageView, snapshot?: PublicStatusView, incidentId?: string): CodeTab[] {
  const origin = API_BASE.replace(/\/api\/v1$/, '');
  const json = `${origin}/status/${page.slug}.json`;
  return [
    { label: 'public JSON', code: `# no key: anyone can read it (cached 30s)\ncurl -s ${json}` },
    { label: 'response', code: `GET /status/${page.slug}.json\n\n${JSON.stringify(snapshot ?? {}, null, 2)}` },
    {
      label: 'tRPC',
      code: [
        '# dashboard calls (no REST yet)',
        `incidents.postUpdate({ incidentId: ${JSON.stringify(incidentId ?? '<open incident>')}, phase: "monitoring", message: "…" })`,
        `statusPages.update({ id: ${JSON.stringify(page.id)}, showIncidents: ${page.showIncidents}, components: [${page.components.length} items] })`,
        `statusPages.setEnabled({ id: ${JSON.stringify(page.id)}, enabled: ${page.enabled} })`,
      ].join('\n'),
    },
  ];
}
