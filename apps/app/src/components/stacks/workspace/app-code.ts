import type { InvService } from '@swarmy/core';
import { curl, toYaml, withHeader, type CodeTab } from '@/components/calm';
import { statusLines } from '@/components/apps/estate-code';
import type { AppItem } from '@/components/apps/use-apps';

type Yaml = Parameters<typeof toYaml>[0];

/** Labels worth showing in the spec: swarmy's own, minus canvas positions and stack plumbing. */
function specLabels(labels: Record<string, string>): Record<string, string> | undefined {
  const keep = Object.entries(labels).filter(
    ([k]) => k.startsWith('swarmy.') && !k.startsWith('swarmy.canvas.'),
  );
  return keep.length ? Object.fromEntries(keep) : undefined;
}

/** Strip the stack prefix Docker adds (`storefront_web` → `web`). */
function shortName(stack: string, name: string): string {
  return name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name;
}

function serviceSpec(s: InvService): Yaml {
  const envKeys = s.env.map((e) => e.split('=')[0]).filter(Boolean) as string[];
  return {
    image: s.image,
    deploy: s.mode === 'global' ? { mode: 'global' } : { replicas: s.replicas.desired },
    ports: s.ports.length ? s.ports.map((p) => (p.published ? `${p.published}:${p.target}` : String(p.target))) : undefined,
    // Values stay out of the page: a variable can hold a secret.
    environment: envKeys.length ? envKeys.map((k) => `${k}=…`) : undefined,
    secrets: s.secrets?.length ? s.secrets : undefined,
    networks: s.networks.length ? s.networks.map((n) => n.name) : undefined,
    labels: specLabels(s.labels),
  };
}

/** The app's live spec as compose, rebuilt from what Docker reports right now. */
export function liveCompose(app: AppItem): string {
  const services = Object.fromEntries(
    app.stat.services.map((s) => [shortName(app.name, s.name), serviceSpec(s)]),
  ) as Yaml;
  return withHeader(`${app.name} · live spec, as swarmy sees it in Docker`, toYaml({ services }));
}

export function appCodeTabs(app: AppItem, stackId: string | null): CodeTab[] {
  const tabs: CodeTab[] = [
    { label: 'compose', code: liveCompose(app) },
    { label: 'CLI', code: withHeader(`in ${app.name}'s linked repo`, ['$ swarmy status', ...statusLines(app)].join('\n')) },
  ];
  if (stackId) tabs.push({ label: 'REST', code: curl('GET', `/stacks/${stackId}`) });
  return tabs;
}
